# Security and deployment model

Branchlab is intended for local use or a small trusted instance, with browser-session isolation and an optional shared instance password. Set `APP_PASSWORD` for any accessible deployment. Hosted live model execution requires it. This is not a multi-tenant SaaS account system.

Model credentials and fixed base URLs belong in server environment variables. Never put them in `NEXT_PUBLIC_*` variables, issue reports, screenshots or exported scenarios. The app does not accept arbitrary browser-supplied URLs and does not give actors network or shell tools.

Source documents are untrusted input. They are presented to models as data, all structured outputs are validated, and only ordinary application code changes world state. This limits the impact of prompt injection but cannot guarantee that a model's prose or decisions ignore malicious source instructions. Treat generated claims as synthetic output and verify evidence before relying on them.

The database stores source text and complete simulation histories. Secure and back up it accordingly. Anyone with the browser session cookie can access that browser's runs; use HTTPS. Exports contain source material and actor histories. No credentials or session identifiers are included.

If you identify a vulnerability, use your hosting repository's private vulnerability reporting feature if enabled, or contact its maintainer privately. Do not publish credentials or private source documents in a public issue. This template does not designate an external recipient or promise a response time.
