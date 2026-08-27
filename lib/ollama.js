"use strict";
const fs = require("node:fs");
const { dirname } = require("node:path");
const { homedir } = require("node:os");
const { configDirectory } = require("./config-path");

const MAX_LEDGER_BYTES = 16 * 1024 * 1024;
const MAX_RECORD_BYTES = 64 * 1024;
const identity = s => [s.dev,s.ino,s.mode,s.size,s.mtimeNs,s.ctimeNs].join(":");
function ledgerPath(env={}, options={}) {
  return options.ledgerFilePath || env.CRIBBLE_OLLAMA_LEDGER || `${configDirectory({homeDirectory:options.homeDirectory||homedir(),env,platform:options.platform||process.platform})}/ollama-usage.jsonl`;
}
function safeInteger(value, name, required=false) {
  if (value == null && !required) return undefined;
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`Ollama ledger contains invalid ${name}.`);
  return value;
}
function validateEvent(raw) {
  if (!raw || raw.schemaVersion !== 1) throw new Error("Ollama ledger contains an unsupported record.");
  const text = (name, max=128) => {
    const value=raw[name]; if(typeof value!=="string"||!value||value.length>max||/[\u0000-\u001f\u007f]/.test(value)) throw new Error(`Ollama ledger contains invalid ${name}.`); return value;
  };
  const occurredAt=text("occurredAt"); if(new Date(occurredAt).toISOString()!==occurredAt) throw new Error("Ollama ledger contains invalid occurredAt.");
  if(raw.billedCostUsd!==0) throw new Error("Ollama local billed cost must be authoritative zero.");
  const provenance=Array.isArray(raw.provenance)?[...new Set(raw.provenance.map(v=>String(v)))]:["local_runtime_ledger"];
  if(!provenance.length||provenance.some(v=>!v||v.length>128)) throw new Error("Ollama ledger contains invalid provenance.");
  return {eventId:text("eventId"),requestId:text("requestId"),occurredAt,agent:text("agent"),provider:text("provider"),runtime:text("runtime"),model:text("model"),provenance,inputTokens:safeInteger(raw.inputTokens,"inputTokens",true),outputTokens:safeInteger(raw.outputTokens,"outputTokens",true),...(raw.cacheCreationTokens==null?{}:{cacheCreationTokens:safeInteger(raw.cacheCreationTokens,"cacheCreationTokens")}),...(raw.cacheReadTokens==null?{}:{cacheReadTokens:safeInteger(raw.cacheReadTokens,"cacheReadTokens")}),...(raw.reasoningTokens==null?{}:{reasoningTokens:safeInteger(raw.reasoningTokens,"reasoningTokens")}),billedCostUsd:0};
}
function readOllamaLedger(filePath, options={}) {
  const f=options.fs||fs; let pathStat;
  try { pathStat=f.lstatSync(filePath,{bigint:true}); } catch(e) { if(e.code==="ENOENT") return []; throw e; }
  if(pathStat.isSymbolicLink()) throw new Error("Ollama ledger must not be a symbolic link.");
  if(!pathStat.isFile()) throw new Error("Ollama ledger must be a regular file.");
  if(pathStat.size>BigInt(MAX_LEDGER_BYTES)) throw new Error("Ollama ledger exceeds the safe byte limit.");
  const flags=fs.constants.O_RDONLY|fs.constants.O_CLOEXEC|(fs.constants.O_NOFOLLOW||0); let fd;
  try {
    fd=f.openSync(filePath,flags); const before=f.fstatSync(fd,{bigint:true});
    if(!before.isFile()||identity(before)!==identity(pathStat)) throw new Error("Ollama ledger path changed before reading.");
    const chunks=[]; let total=0; const buffer=Buffer.allocUnsafe(64*1024);
    for(;;){const count=f.readSync(fd,buffer,0,Math.min(buffer.length,MAX_LEDGER_BYTES+1-total),null);if(!count)break;total+=count;if(total>MAX_LEDGER_BYTES)throw new Error("Ollama ledger exceeds the safe byte limit.");chunks.push(Buffer.from(buffer.subarray(0,count)));}
    options.afterRead?.(); const after=f.fstatSync(fd,{bigint:true}); const finalPath=f.lstatSync(filePath,{bigint:true});
    if(identity(before)!==identity(after)||identity(after)!==identity(finalPath)) throw new Error("Ollama ledger changed while being read.");
    const bytes=Buffer.concat(chunks,total); if(bytes.length&&!bytes.subarray(-1).equals(Buffer.from("\n"))) throw new Error("Ollama ledger must contain complete newline-framed records.");
    const seen=new Map(); for(const line of bytes.toString("utf8").split("\n")){if(!line)continue;if(Buffer.byteLength(line)>MAX_RECORD_BYTES)throw new Error("Ollama ledger contains an oversized record.");let raw;try{raw=JSON.parse(line);}catch{throw new Error("Ollama ledger contains invalid or partial JSON.");}const event=validateEvent(raw);const key=event.requestId;const prior=seen.get(key);if(prior){if(prior.occurredAt!==event.occurredAt||prior.model!==event.model||prior.inputTokens!==event.inputTokens||prior.outputTokens!==event.outputTokens)throw new Error("Ollama ledger has conflicting request identity.");prior.provenance=[...new Set([...prior.provenance,...event.provenance])];}else seen.set(key,event);} return [...seen.values()];
  } finally { if(fd!==undefined)f.closeSync(fd); }
}
function appendOllamaEvent(filePath, event, options={}) {
  const f=options.fs||fs; f.mkdirSync(dirname(filePath),{recursive:true,mode:0o700});
  let stat; try{stat=f.lstatSync(filePath,{bigint:true});}catch(e){if(e.code!=="ENOENT")throw e;}
  if(stat){if(stat.isSymbolicLink()||!stat.isFile()||stat.uid!==BigInt(process.getuid?.()??Number(stat.uid)))throw new Error("Ollama ledger path is not an owned regular file.");try{(options.chmodSyncFn||f.chmodSync)(filePath,0o600);}catch{throw new Error("Could not establish secure ledger permissions.");}}
  const value=validateEvent(event); const data=`${JSON.stringify({...value,schemaVersion:1})}\n`; if(Buffer.byteLength(data)>MAX_RECORD_BYTES)throw new Error("Ollama record exceeds the safe byte limit.");
  const fd=f.openSync(filePath,fs.constants.O_WRONLY|fs.constants.O_APPEND|fs.constants.O_CREAT|fs.constants.O_CLOEXEC|(fs.constants.O_NOFOLLOW||0),0o600);try{f.fchmodSync(fd,0o600);const secure=f.fstatSync(fd,{bigint:true});if(!secure.isFile()||(secure.mode&0o777n)!==0o600n)throw new Error("Could not establish secure ledger permissions.");f.writeSync(fd,data);f.fsyncSync(fd);}finally{f.closeSync(fd);}
}
function loadOllamaUsage(env={}, options={}) { const events=readOllamaLedger(ledgerPath(env,options),options); return {events,sources:events.length?["ollama"]:[]}; }
module.exports={MAX_LEDGER_BYTES,appendOllamaEvent,ledgerPath,loadOllamaUsage,readOllamaLedger,validateEvent};
