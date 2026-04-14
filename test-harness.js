#!/usr/bin/env node
/**
 * Headless test harness for the counterpoint solver.
 * Extracts JS from the HTML, patches DOM deps, runs the solver.
 */
const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const html = fs.readFileSync(path.join(__dirname, 'neuer gpt version 3er.html'), 'utf-8');
const scriptMatch = html.match(/<script>([\s\S]*?)<\/script>/);
if (!scriptMatch) { console.error('No <script> block found'); process.exit(1); }
let jsCode = scriptMatch[1];

// Cut at UI controller
const uiCutoff = jsCode.indexOf('const startBtn = document.getElementById');
if (uiCutoff > 0) jsCode = jsCode.substring(0, uiCutoff);

// Split into lines for precise surgery
const lines = jsCode.split('\n');

// Find and blank the problematic DOM-dependent block (lines ~2139-2220 in original)
// Strategy: blank lines from 'function updateDownloadLink' through 'function log(...) { ... }'
let blankStart = -1, blankEnd = -1;
for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim().startsWith('function updateDownloadLink')) { blankStart = i; }
    // End AFTER log function definition
    if (blankStart >= 0 && lines[i].trim().startsWith('function log(msg')) {
        // Find the closing brace of log()
        let depth = 0, started = false;
        for (let j = i; j < lines.length; j++) {
            for (const ch of lines[j]) { if (ch === '{') { depth++; started = true; } if (ch === '}') depth--; }
            if (started && depth === 0) { blankEnd = j; break; }
        }
        break;
    }
}
if (blankStart >= 0 && blankEnd >= 0) {
    for (let i = blankStart; i <= blankEnd; i++) lines[i] = '';
}

// Also blank 'let stopRequested', 'let lastResult', 'let isGenerating'
for (let i = 0; i < lines.length; i++) {
    const t = lines[i].trim();
    if (t.startsWith('let stopRequested') || t.startsWith('let lastResult') || t.startsWith('let isGenerating')) {
        lines[i] = '';
    }
}

jsCode = lines.join('\n');

// Build module
const moduleCode = `
// ── DOM / Browser stubs ──
const document = {
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    createElement: () => ({className:'',textContent:'',style:{},appendChild:()=>{}}),
};
const window = { addEventListener: () => {} };
const localStorage = { _d:{}, getItem(k){return this._d[k]||null;}, setItem(k,v){this._d[k]=v;}, removeItem(k){delete this._d[k];} };
const URL = { createObjectURL:()=>'blob:', revokeObjectURL:()=>{} };
class Blob { constructor(){} }
class FileReader { readAsArrayBuffer(){} readAsText(){} }
const alert = () => {};
class Midi { constructor(){this.tracks=[];this.header={tempos:[{bpm:120}]};} toArray(){return new Uint8Array(0);} }

// ── Stubs for blanked code ──
let stopRequested = false;
let lastResult = null;
let isGenerating = false;
function log(msg, type) {}
function clearLogViewForNewRun() {}
function appendLogLine() {}
function updateDownloadLink() {}
function setDownloadWorkingState() {}

// ══════════════════════════════════
// SOLVER CODE (extracted from HTML)
// ══════════════════════════════════
${jsCode}

// ── Functions defined after UI cutoff that we still need ──
function countFatalViolations(violations) {
    let n = 0;
    for (const v of (violations || [])) {
        const id = ruleIdOf(v);
        if (FATAL_RULES.has(id)) n++;
    }
    return n;
}

// ══════════════════════════════════
// TEST RUNNER
// ══════════════════════════════════
const TEST_CF_NOTES = [62, 65, 64, 62, 67, 65, 69, 67, 65, 64, 62];
const cantusVoice = {
    events: TEST_CF_NOTES.map((pitch, i) => ({ pitch, start: i, duration: 1 }))
};

const assignments = [
    { 0:'cantus', 1:'sp2', 2:'sp3', 3:'sp1' },
    { 0:'cantus', 1:'sp1', 2:'sp2', 3:'sp3' },
    { 0:'cantus', 1:'sp1', 2:'sp3', 3:'sp2' },
    { 0:'cantus', 1:'sp2', 2:'sp1', 3:'sp3' },
    { 0:'cantus', 1:'sp3', 2:'sp1', 3:'sp2' },
    { 0:'cantus', 1:'sp3', 2:'sp2', 3:'sp1' },
];

const beam = 120;
const allResults = [];

for (const config of assignments) {
    const label = 'A='+config[1]+' T='+config[2]+' B='+config[3];
    const startMs = Date.now();
    try {
        const searchOpts = {
            ...SEARCH_OPTS_DEFAULTS,
            beamBase: Math.max(6, Math.floor(beam * 0.22)),
            beamDownbeat: Math.max(18, Math.floor(beam * 0.55)),
            beamCadence: Math.max(32, Math.floor(beam * 1.0)),
            maxRunMs: 25000,
            searchPhase: 'balanced',
            disableCadencePrefill: true,
            seedBase: 1337,
        };
        const solver = new MixedSolver(beam, searchOpts);
        const result = await solver.solve(cantusVoice, config);
        const elapsed = Date.now() - startMs;
        if (!result) { allResults.push({label, status:'NO_RESULT', elapsed}); continue; }

        const meta = scoreResult(result, 0);
        const hp = hardPenaltyOnly(toRuleIdList(result.violations), new Set());
        meta.hardPenalty = Number.isFinite(hp) ? hp : Infinity;
        meta.fatalCount = countFatalViolations(result.violations);
        const r26 = (result.violations||[]).filter(v => ruleIdOf(v)===26).length;
        const summary = summarizeViolations(result.violations, 10);

        allResults.push({
            label, elapsed,
            status: meta.hardPenalty===0 && meta.fatalCount===0 ? 'SOLVED' : 'VIOLATIONS',
            hardPenalty: Math.round(meta.hardPenalty),
            fatalCount: meta.fatalCount,
            weighted: Math.round(meta.weighted),
            hardCount: meta.hardCount,
            aesthetic: Math.round(meta.aesthetic),
            r26,
            topViolations: summary.map(s => ({id:s.ruleId, name:s.name, count:s.count, pts:s.points})),
        });
    } catch(e) {
        allResults.push({label, status:'ERROR', error:e.message, elapsed:Date.now()-startMs});
    }
}

// ── Output ──
console.log('');
console.log('=== COUNTERPOINT SOLVER TEST RESULTS ===');
console.log('CF: d f e d g f a g f e d');
console.log('Beam: '+beam);
console.log('');
let solved = 0;
for (const r of allResults) {
    const icon = r.status==='SOLVED' ? 'PASS' : 'FAIL';
    console.log(icon+' | '+r.label+' | '+r.status+
        (r.weighted!==undefined ? ' | hard='+r.hardPenalty+' fatal='+r.fatalCount+' weighted='+r.weighted+' aesth='+r.aesthetic+' R26='+r.r26 : '')+
        (r.error ? ' | ERR: '+r.error : '')+' | '+r.elapsed+'ms');
    if (r.topViolations) {
        for (const v of r.topViolations.slice(0,5)) {
            console.log('     #'+v.id+' '+v.name+' ('+v.count+'x, '+v.pts+'pts)');
        }
    }
    if (r.status==='SOLVED') solved++;
}
console.log('');
console.log('=== SUMMARY: '+solved+'/'+allResults.length+' SOLVED ===');
`;

const tmpFile = path.join(__dirname, '_test_tmp.mjs');
fs.writeFileSync(tmpFile, moduleCode);

try {
    execSync('node ' + JSON.stringify(tmpFile), { stdio: 'inherit', timeout: 300000, cwd: __dirname });
} catch (e) {
    if (e.status) process.exit(e.status);
} finally {
    try { fs.unlinkSync(tmpFile); } catch {}
}
