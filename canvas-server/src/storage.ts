import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type CanvasUser = { id: number; subject: string; username: string; display_name: string };
export type SessionRow = { hash: string; owner: string; grant_id: string; credential: string; csrf: string; user_json: string; expires_at: number; last_active: number };
export type LoginRow = { hash: string; state_hash: string; verifier: string; expires_at: number };
export type FileRow = { id: string; owner: string; kind: string; filename: string; mime_type: string; bytes: number };
export type GenerationRow = { id: string; owner: string; kind: string; value: string; gateway_task_id: string | null; status: string; created_at: number; updated_at: number };

export class CanvasStorage {
    readonly db: Database;
    readonly fileDir: string;

    constructor(dataDir: string) {
        mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        this.fileDir = join(dataDir, "files");
        mkdirSync(this.fileDir, { recursive: true, mode: 0o700 });
        this.db = new Database(join(dataDir, "canvas.sqlite"), { create: true, strict: true });
        this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
        const version = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
        if (version > 1) throw new Error("Canvas database version is newer than this server");
        this.db.transaction(() => {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS users (owner TEXT PRIMARY KEY, user_json TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS login_transactions (hash TEXT PRIMARY KEY, state_hash TEXT NOT NULL, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(owner), grant_id TEXT NOT NULL UNIQUE, credential TEXT NOT NULL, csrf TEXT NOT NULL, user_json TEXT NOT NULL, expires_at INTEGER NOT NULL, last_active INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS documents (owner TEXT NOT NULL REFERENCES users(owner), domain TEXT NOT NULL, value TEXT NOT NULL, revision INTEGER NOT NULL, PRIMARY KEY(owner,domain));
                CREATE TABLE IF NOT EXISTS files (id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(owner), kind TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL, bytes INTEGER NOT NULL);
                CREATE INDEX IF NOT EXISTS files_owner ON files(owner);
                CREATE TABLE IF NOT EXISTS prompt_assets (id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(owner), source_url TEXT NOT NULL, file_id TEXT, UNIQUE(owner,source_url));
                CREATE TABLE IF NOT EXISTS generations (id TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(owner), kind TEXT NOT NULL, value TEXT NOT NULL, gateway_task_id TEXT, status TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
                CREATE INDEX IF NOT EXISTS generations_owner ON generations(owner,kind,created_at);
                CREATE INDEX IF NOT EXISTS generations_task ON generations(owner,gateway_task_id);
                CREATE TABLE IF NOT EXISTS pending_revocations (grant_id TEXT PRIMARY KEY);
                PRAGMA user_version=1;
            `);
        })();
    }

    session(hash: string): SessionRow | null {
        return this.db.query("SELECT * FROM sessions WHERE hash = ?").get(hash) as SessionRow | null;
    }

    retire(session: SessionRow): void {
        this.db.transaction(() => {
            this.db.query("INSERT OR IGNORE INTO pending_revocations(grant_id) VALUES (?)").run(session.grant_id);
            this.db.query("DELETE FROM sessions WHERE hash = ?").run(session.hash);
        })();
    }

    createSession(session: SessionRow): void {
        this.db.transaction(() => {
            this.db.query("INSERT INTO users(owner,user_json) VALUES (?,?) ON CONFLICT(owner) DO UPDATE SET user_json=excluded.user_json").run(session.owner, session.user_json);
            this.db.query("INSERT INTO sessions VALUES (?,?,?,?,?,?,?,?)").run(session.hash, session.owner, session.grant_id, session.credential, session.csrf, session.user_json, session.expires_at, session.last_active);
        })();
    }

    file(owner: string, id: string): FileRow | null {
        return this.db.query("SELECT * FROM files WHERE owner = ? AND id = ?").get(owner, id) as FileRow | null;
    }

    close(): void {
        this.db.close();
    }
}
