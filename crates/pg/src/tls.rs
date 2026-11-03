//! TLS setup that follows libpq's `sslmode` semantics on top of rustls.
//!
//! | mode          | encrypts            | verifies chain | verifies host name |
//! | ------------- | ------------------- | -------------- | ------------------ |
//! | `disable`     | no                  | -              | -                  |
//! | `prefer`      | if the server can   | no             | no                 |
//! | `require`     | yes                 | no             | no                 |
//! | `verify-ca`   | yes                 | yes            | no                 |
//! | `verify-full` | yes                 | yes            | yes                |

use std::path::{Path, PathBuf};
use std::sync::Arc;

use rustls::client::WebPkiServerVerifier;
use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::crypto::{CryptoProvider, WebPkiSupportedAlgorithms};
use rustls::{ClientConfig, DigitallySignedStruct, RootCertStore, SignatureScheme};
use rustls_pki_types::pem::PemObject;
use rustls_pki_types::{CertificateDer, PrivateKeyDer, ServerName, UnixTime};
use serde::{Deserialize, Serialize};
use tokio_postgres_rustls::MakeRustlsConnect;

use crate::Error;

/// libpq's `sslmode`.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "kebab-case")]
pub enum SslMode {
    Disable,
    #[default]
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

/// TLS settings of a connection. Paths point to PEM files.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize, specta::Type)]
#[serde(rename_all = "camelCase")]
pub struct SslOptions {
    pub mode: SslMode,
    /// CA certificates to trust; the system store is used when unset.
    pub root_cert: Option<PathBuf>,
    pub client_cert: Option<PathBuf>,
    pub client_key: Option<PathBuf>,
}

impl SslMode {
    pub(crate) fn to_postgres(self) -> tokio_postgres::config::SslMode {
        use tokio_postgres::config::SslMode as Pg;
        match self {
            Self::Disable => Pg::Disable,
            Self::Prefer => Pg::Prefer,
            Self::Require | Self::VerifyCa | Self::VerifyFull => Pg::Require,
        }
    }
}

fn provider() -> Arc<CryptoProvider> {
    Arc::new(rustls::crypto::ring::default_provider())
}

fn tls_error(context: &str, error: impl std::fmt::Display) -> Error {
    Error::Tls(format!("{context}: {error}"))
}

fn read_certs(path: &Path) -> Result<Vec<CertificateDer<'static>>, Error> {
    CertificateDer::pem_file_iter(path)
        .and_then(Iterator::collect)
        .map_err(|e| {
            tls_error(
                &format!("cannot read certificates from {}", path.display()),
                e,
            )
        })
}

fn root_store(options: &SslOptions) -> Result<RootCertStore, Error> {
    let mut roots = RootCertStore::empty();
    if let Some(path) = &options.root_cert {
        for cert in read_certs(path)? {
            roots
                .add(cert)
                .map_err(|e| tls_error("invalid CA certificate", e))?;
        }
    } else {
        let native = rustls_native_certs::load_native_certs();
        roots.add_parsable_certificates(native.certs);
    }
    if roots.is_empty() {
        return Err(Error::Tls("no CA certificates are available".to_owned()));
    }
    Ok(roots)
}

/// Builds the connector for the given options. `disable` still gets a connector,
/// because tokio-postgres needs one type for every mode; it is never used.
pub(crate) fn connector(options: &SslOptions) -> Result<MakeRustlsConnect, Error> {
    let provider = provider();
    let builder = ClientConfig::builder_with_provider(Arc::clone(&provider))
        .with_safe_default_protocol_versions()
        .map_err(|e| tls_error("TLS setup failed", e))?;

    let verifier: Arc<dyn ServerCertVerifier> = match options.mode {
        SslMode::Disable | SslMode::Prefer | SslMode::Require => Arc::new(NoVerification {
            algorithms: provider.signature_verification_algorithms,
        }),
        SslMode::VerifyCa | SslMode::VerifyFull => {
            let webpki = WebPkiServerVerifier::builder_with_provider(
                Arc::new(root_store(options)?),
                Arc::clone(&provider),
            )
            .build()
            .map_err(|e| tls_error("TLS setup failed", e))?;
            if options.mode == SslMode::VerifyCa {
                Arc::new(IgnoreHostName { inner: webpki })
            } else {
                webpki
            }
        }
    };
    let builder = builder
        .dangerous()
        .with_custom_certificate_verifier(verifier);

    let config = match (&options.client_cert, &options.client_key) {
        (Some(cert), Some(key)) => {
            let certs = read_certs(cert)?;
            let key = PrivateKeyDer::from_pem_file(key)
                .map_err(|e| tls_error(&format!("cannot read private key {}", key.display()), e))?;
            builder
                .with_client_auth_cert(certs, key)
                .map_err(|e| tls_error("invalid client certificate", e))?
        }
        (None, None) => builder.with_no_client_auth(),
        _ => {
            return Err(Error::Tls(
                "set both the client certificate and its key, or neither".to_owned(),
            ));
        }
    };
    Ok(MakeRustlsConnect::new(config))
}

/// Accepts any certificate, as libpq does for `prefer` and `require`.
#[derive(Debug)]
struct NoVerification {
    algorithms: WebPkiSupportedAlgorithms,
}

impl ServerCertVerifier for NoVerification {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(message, cert, dss, &self.algorithms)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(message, cert, dss, &self.algorithms)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.algorithms.supported_schemes()
    }
}

/// Verifies the chain but not the host name (`verify-ca`).
#[derive(Debug)]
struct IgnoreHostName {
    inner: Arc<WebPkiServerVerifier>,
}

impl ServerCertVerifier for IgnoreHostName {
    fn verify_server_cert(
        &self,
        end_entity: &CertificateDer<'_>,
        intermediates: &[CertificateDer<'_>],
        server_name: &ServerName<'_>,
        ocsp_response: &[u8],
        now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        match self.inner.verify_server_cert(
            end_entity,
            intermediates,
            server_name,
            ocsp_response,
            now,
        ) {
            Err(rustls::Error::InvalidCertificate(
                rustls::CertificateError::NotValidForName
                | rustls::CertificateError::NotValidForNameContext { .. },
            )) => Ok(ServerCertVerified::assertion()),
            other => other,
        }
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls12_signature(message, cert, dss)
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        self.inner.verify_tls13_signature(message, cert, dss)
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.inner.supported_verify_schemes()
    }
}
