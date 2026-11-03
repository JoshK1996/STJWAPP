# ADR0018: Privileged roles save directly, including their own records

Status: accepted by the owner November 3, 2026. Supersedes self-review and separate developer provisioning restrictions in ADR0013/0017 and prior developer-role rules.

Developer, owner and administrator password sessions can save their own time cards, missing shifts and missed clock-outs immediately. They can resolve existing own time and schedule proposals; generic own leave/note entries are recorded directly. The schedule UI uses direct editing for these roles. Ordinary employees and scoped managers retain independent review.

Developer is the highest application role: every valid role can be created through the staff form or import, and any same-organization account can be managed, including their own. Administrators may create/manage peer administrator and lower roles, including their own administrator account. Existing hierarchy protects developer/owner accounts from lower roles. Self credential changes remain available directly in Settings. An active self-account edit with the same role retains the current password session while revoking other sessions and tokens; explicit self deactivation or role change ends the old session.

Use server-verified current identity, role, session/MFA and organization for authority. Source hashes, revisions, exact command replay, valid jobs, overlap/future-time validation, atomic audit/history and organization isolation remain mandatory. UI permission metadata must match the write service; do not decide direct mode from employee identity. Current privileged-role database exceptions replace unconditional self-review constraints in migration 052, without rewriting records or changing terminal/source immutability. Retained historical decisions remain valid after later role changes.

Verification and deployment receipts are maintained in STATUS/VALIDATION. No production customer account is used for tests.
