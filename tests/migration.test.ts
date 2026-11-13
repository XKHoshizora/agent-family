import { it, expect } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import Database from "better-sqlite3";

it("upgrades legacy counters, messages and bindings without widening LINE access, and is idempotent", () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "agent-family-migration-"));
  const db = new Database(path.join(folder,"agent-family.sqlite"));
  // The original CREATE statements describe the pre-migration layout.
  const schema = fs.readFileSync("server/db.ts","utf8").match(/db\.exec\(`([\s\S]*?)`\);/)![1];
  db.exec(schema);
  db.prepare("INSERT INTO workspaces VALUES('w','legacy','2026-11-13')").run();
  db.prepare("INSERT INTO rooms VALUES('r','w','room','','discuss','[]','u','private',0,'2026-11-13','2026-11-13')").run();
  db.prepare("INSERT INTO runs VALUES('run','r','completed','parallel','2026-11-13',NULL,NULL)").run();
  db.prepare("INSERT INTO messages VALUES('m','r','run','user',NULL,'old user',NULL,'unchanged history','complete','web','2026-11-13',0,'[]')").run();
  db.prepare("INSERT INTO usage_daily VALUES('w','2026-11-13',7,99)").run();
  db.prepare("INSERT INTO line_channels VALUES('c','w','test','test',1,1,'2026-11-13')").run();
  db.prepare("INSERT INTO line_bindings VALUES('g','c','r','2026-11-13')").run();
  db.close();
  const script = `
    const {db,addMessage}=await import('./server/db.ts');
    const binding=db.prepare("SELECT * FROM line_bindings").get();
    if(process.env.ADD_NEW==='1')addMessage({roomId:'r',runId:'run',role:'assistant',agentId:'a',author:'agent',model:'mock',content:'new answer',status:'complete',source:'line',round:2});
    console.log(JSON.stringify({binding,usage:db.prepare("SELECT * FROM usage_daily").get(),history:db.prepare("SELECT content FROM messages WHERE id='m'").get(),rounds:db.prepare("SELECT round FROM messages ORDER BY rowid").all(),integrity:db.pragma('integrity_check',{simple:true})}));db.close();`;
  const invoke = (add: boolean) => JSON.parse(execFileSync(process.execPath,["--import","tsx","--input-type=module","-e",script],{encoding:"utf8",cwd:process.cwd(),env:{...process.env,DATA_DIR:folder,CANAL_API_KEY:"",CANAL_KEY_FILE:path.join(folder,"no-key"),ADD_NEW:add?"1":"0"}}));
  try {
    const first=invoke(true), second=invoke(false);
    expect(first.integrity).toBe("ok");
    expect(first.usage.calls).toBe(7);expect(first.usage.tokens).toBe(99);expect(first.usage.reserved).toBe(0);
    expect(first.history.content).toBe("unchanged history");
    expect(first.binding.mode).toBe("parallel");expect(first.binding.share_tools).toBe(0);
    expect(first.binding.context_after).toBe(1);expect(first.binding.scope_id).toBeTruthy();
    expect(first.rounds.map((r:any)=>r.round)).toEqual([1,2]);
    expect(second.binding).toEqual(first.binding);
    expect(second.integrity).toBe("ok");
  } finally {
    if(path.dirname(path.resolve(folder))!==path.resolve(os.tmpdir()))throw new Error("Unexpected temporary directory");
    fs.rmSync(folder,{recursive:true,force:true});
  }
});
