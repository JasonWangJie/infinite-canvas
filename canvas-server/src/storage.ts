import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type CanvasUser = { id: number; subject: string; username: string; display_name: string };
export type SessionRow = { hash: string; owner: string; grant_id: string; credential: string; csrf: string; user_json: string; expires_at: number; last_active: number };
export type LoginRow = { hash: string; state_hash: string; verifier: string; expires_at: number };

export class CanvasStorage {
    readonly db: Database;

    constructor(dataDir: string) {
        mkdirSync(dataDir, { recursive: true, mode: 0o700 });
        this.db = new Database(join(dataDir, "canvas.sqlite"), { create: true, strict: true });
        this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
        const version = (this.db.query("PRAGMA user_version").get() as { user_version: number }).user_version;
        if (version > 1) throw new Error("Canvas database version is newer than this server");
        this.db.transaction(() => {
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS users (owner TEXT PRIMARY KEY, user_json TEXT NOT NULL);
                CREATE TABLE IF NOT EXISTS login_transactions (hash TEXT PRIMARY KEY, state_hash TEXT NOT NULL, verifier TEXT NOT NULL, expires_at INTEGER NOT NULL);
                CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, owner TEXT NOT NULL REFERENCES users(owner), grant_id TEXT NOT NULL UNIQUE, credential TEXT NOT NULL, csrf TEXT NOT NULL, user_json TEXT NOT NULL, expires_at INTEGER NOT NULL, last_active INTEGER NOT NULL);
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

    close(): void {
        this.db.close();
    }
}
