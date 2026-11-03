-- Sample data for manual testing. Runs only on the first start of the container.
CREATE TABLE users (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name text NOT NULL,
  email text UNIQUE,
  profile jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One million rows to check scrolling and paging performance.
INSERT INTO users (name, email, profile)
SELECT
  'user ' || i,
  'user' || i || '@example.com',
  jsonb_build_object('age', i % 80, 'tags', jsonb_build_array('a', 'b'))
FROM generate_series(1, 1000000) AS i;
