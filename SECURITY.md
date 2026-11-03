# Security policy

Please report vulnerabilities privately through
[GitHub Security Advisories](https://github.com/inoue723/db-editor/security/advisories/new),
not in public issues.

db editor stores database credentials only in the OS keychain (macOS Keychain, Linux Secret
Service) and never writes them to configuration files or logs. Reports about credential handling
are especially welcome.
