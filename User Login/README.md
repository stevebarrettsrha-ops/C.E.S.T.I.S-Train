# User Login

This folder documents where each user account's data lives so the system keeps
working — and every user can keep signing in — for the long term, including a
future where C.E.S.T.I.S runs locally / self-hosted instead of from the cloud.

## Structure

Each user gets their own sub-folder, named after their account:

```
User Login/
├── README.md                ← this file (tracked in git)
├── _TEMPLATE/               ← the shape of a per-user folder (tracked, placeholder only)
│   ├── account.example.json
│   └── profile.example.json
└── <username> (USR-XXXX)/   ← real per-user folders live HERE at runtime (NOT committed)
    ├── account.json         ← the account record (hashed credentials only)
    └── profile.json         ← the user's profile / dashboard data
```

The **same structure is created in Google Drive**, inside the main backup folder,
under a `User Login` sub-folder — one named sub-folder per account. That Drive
copy is written automatically while a user is signed in, and an administrator can
rebuild every user's folder at once from **Cloud ▸ Build User Login Folders**.

## ⚠️ Security: what is and is NOT stored here

**This GitHub repository is public.** Real login credentials must **never** be
committed to it. To make that impossible by accident, everything under
`User Login/` is git-ignored except this `README.md` and the `_TEMPLATE/` example
(see `.gitignore`). Real per-user folders created on a machine stay on that
machine and in the institution's access-controlled Google Drive.

Even where account records *are* stored (locally and in Google Drive), they only
ever contain the **SHA-256 hash** of the password — never the plaintext. The app
strips the in-memory plaintext cache before anything is written to disk or Drive.
Two-step-verification secrets and backup codes are likewise part of the hashed
account record, kept only in the access-controlled store, never in this repo.

## Why this exists (longevity)

The live system keeps all data in the browser's IndexedDB and mirrors it to
Google Drive as an off-device backup. If the cloud services are ever retired and
C.E.S.T.I.S is run locally, this per-user folder layout is the hand-off format:
each user's account (hashed) and profile can be exported into their own folder
here, so no one is locked out of their account regardless of the device or how
the system is being hosted.

## How a user always keeps access to their account

- The account record (with its hashed password and any two-step-verification
  secret) syncs across devices through Google Drive, so signing in works from any
  device once cloud sync has run.
- Certificate-download approval travels with the account and follows the student
  even when duplicate records are merged during a sync.
- Losing an authenticator does not lock anyone out: a recovery email is required
  before two-step verification can be switched on, and password reset / recovery
  goes to that address.
