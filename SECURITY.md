# Security

Please report vulnerabilities privately through GitHub's **Report a vulnerability** control in this repository's Security tab when it is enabled. If that control is unavailable, wait for the maintainer to enable a private reporting channel before sending sensitive details. Public issues can request a private channel without describing the vulnerability.

Include the affected commit, a minimal reproduction with synthetic users, expected and observed behavior, and the security impact. Keep statements, personal financial records, passwords, tokens and database dumps out of reports and attachments. Revoke any exposed credentials through the relevant provider.

Security fixes target the current default branch. Review deployment configuration, role permissions and optional integrations before hosting an instance. Use `APP_DATABASE_URL` with the restricted `app_user` role at runtime and keep administrative credentials limited to maintenance tooling.
