# Unified backup (format v2)

The v1 archive only held `agent-family.sqlite`, `.secrets.json` and `manifest.json`. That left out
`data/matrix-agents/<agentId>/` (`sync.json` from `SimpleFsStorageProvider`, plus `crypto/` from
`RustSdkCryptoStorageProvider`, which is a SQLite store). Without it, restored Agents lose their E2EE
device keys.

## Format v2
- Adds `matrix-agents/<agentId>/<file>` and `matrix-agents/<agentId>/crypto/<file>` entries.
- `manifest.files[]` holds `{path, kind: "sqlite"|"file", bytes, sha256}`. There is also
  `secretsSha256`. The v1 `databaseSha256` is kept.
- A file whose header is `SQLite format 3\0` is copied with the better-sqlite3 online backup API, so
  WAL content is included. `-wal`, `-shm` and `-journal` sidecars are never archived, and restore
  rejects them. Any other file (JSON) is copied byte for byte.
- v1 archives still restore. They must contain exactly the three core entries.

## Validation
- Backup refuses symlinks, special files, unsafe or Windows-reserved names, and directories other than
  `<agentId>/` and `<agentId>/crypto/`. It does not skip them silently.
- Restore checks the target first: it must not be a symlink and must be empty or missing. Before
  decompressing, it checks every entry's path, its declared size (default limits: 512 MB per file,
  1 GB total, 5000 entries) and the archive size (200 MB). It then re-checks the real sizes and
  requires the manifest list to match the archive entries exactly (no case-insensitive duplicates).
  It verifies every sha256 and the SQLite header for each `sqlite` entry. Only then does it create
  the target. After writing, it runs `integrity_check` on every restored SQLite file.

## Limitation: no global atomicity
Each SQLite file is a consistent snapshot on its own. The archive as a whole is **not** an atomic
point-in-time capture: the main DB, each crypto store and `sync.json` are read one after another. If an
Agent runner is active, the crypto store and sync token can drift from each other or from the main DB.
For consistent disaster recovery, **stop the Agent runners (or the server) before running a backup**.
Live backups are best-effort.

Other limits: fflate decompresses in memory (the archive is capped at 200 MB). If a restore fails part
way, the target may hold partial files and must be cleaned up by hand. An encrypted (non-plain-SQLite)
store would be copied as raw bytes and is not WAL-safe.
