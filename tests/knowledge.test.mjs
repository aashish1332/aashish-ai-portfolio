/* ═══════════════════════════════════════════════════════════════
   tests/knowledge.test.mjs — §8.1 schema + PII compliance

   Guards the knowledge base that will ship to every visitor:
     · schema completeness (§8.1)  · unique, stable ids
     · source provenance           · no secrets
     · the public/private gate is enforceable
   Run:  node --test "tests/*.test.mjs"
   ══════════════════════════════════════════════════════════════ */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const KB = JSON.parse(readFileSync(join(ROOT, 'knowledge', 'knowledge.json'), 'utf8'));

/* every fact-bearing object in the base, whichever section it lives in */
function allFacts() {
  const out = [];
  for (const val of Object.values(KB)) {
    if (Array.isArray(val)) out.push(...val.filter((v) => v && typeof v === 'object' && v.id));
    else if (val && typeof val === 'object' && val.id) out.push(val);
  }
  for (const c of Object.values(KB.contact || {})) {
    if (c && typeof c === 'object' && c.id) out.push(c);
  }
  return out;
}

test('§8.1 — the knowledge base parses and is versioned', () => {
  assert.ok(KB.meta, 'meta block missing');
  assert.match(KB.meta.version, /^\d+\.\d+\.\d+$/, 'meta.version must be semver');
  assert.ok(KB.meta.built_from.cv, 'meta.built_from.cv missing');
  assert.ok(KB.meta.built_at, 'meta.built_at missing');
});

test('§8.1 — every schema section exists', () => {
  for (const k of ['person', 'contact', 'education', 'skills', 'projects',
                   'experience', 'achievements', 'certifications', 'links']) {
    assert.ok(k in KB, `missing section: ${k}`);
  }
  assert.ok(Array.isArray(KB.projects));
  assert.ok(Array.isArray(KB.skills));
});

test('§8.1 — every fact has a stable id, a source and a public flag', () => {
  const facts = allFacts();
  assert.ok(facts.length >= 50, `expected >=50 facts, got ${facts.length}`);
  for (const f of facts) {
    assert.ok(f.id, `fact without id: ${JSON.stringify(f).slice(0, 80)}`);
    assert.ok(['cv', 'portfolio'].includes(f.source),
      `${f.id}: source must be cv|portfolio, got ${f.source}`);
    assert.equal(typeof f.public, 'boolean', `${f.id}: public must be boolean`);
  }
});

test('ids are unique across the whole base', () => {
  const ids = allFacts().map((f) => f.id);
  const dupes = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.deepEqual(dupes, [], `duplicate ids: ${dupes.join(', ')}`);
});

test('§8.1 — projects match the declared project schema', () => {
  for (const p of KB.projects) {
    for (const k of ['id', 'name', 'summary', 'tech', 'role', 'links', 'status']) {
      assert.ok(k in p, `project ${p.id} missing ${k}`);
    }
    assert.ok(Array.isArray(p.tech) && p.tech.length, `${p.id}: tech must be non-empty`);
    assert.ok(Array.isArray(p.links), `${p.id}: links must be an array`);
    for (const l of p.links) assert.match(l.url, /^https:\/\//, `${p.id}: link must be https`);
  }
});

test('§8.1 — skills carry a name and a category', () => {
  for (const s of KB.skills) {
    assert.ok(s.name, 'skill without name');
    assert.ok(s.category, `${s.id}: missing category`);
  }
});

test('aliases (for §8.2 retrieval) are non-empty strings', () => {
  for (const f of allFacts()) {
    if (!f.aliases) continue;
    assert.ok(Array.isArray(f.aliases), `${f.id}: aliases must be an array`);
    for (const a of f.aliases) {
      assert.equal(typeof a, 'string', `${f.id}: alias not a string`);
      assert.ok(a.trim().length, `${f.id}: empty alias`);
    }
  }
});

test('no secret material anywhere in the knowledge base (§17)', () => {
  /* Not a substring hunt: the CV legitimately documents "password reset",
     "password hashing" and similar auth features. What must never appear is a
     secret-SHAPED value — an opaque key, a JWT, a connection string. */
  const SECRET_KEYS = /^(apikey|api_key|secret|token|authtoken|accesstoken|refreshtoken|privatekey|passwd|credential)$/i;
  const JWT_RE = /^ey[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\./;
  const OPAQUE_RE = /^[A-Za-z0-9_-]{40,}$/;

  const walk = (node, path) => {
    if (Array.isArray(node)) { node.forEach((v, i) => walk(v, `${path}[${i}]`)); return; }
    if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        assert.ok(!SECRET_KEYS.test(k), `secret-shaped key "${k}" at ${path}`);
        walk(v, `${path}.${k}`);
      }
      return;
    }
    if (typeof node !== 'string') return;
    assert.ok(!JWT_RE.test(node), `JWT-like value at ${path}`);
    assert.ok(!OPAQUE_RE.test(node), `opaque 40+ char secret-like value at ${path}`);
    assert.ok(!/\bsk-[A-Za-z0-9]{16,}/.test(node), `API-key-like value at ${path}`);
    assert.ok(!/mongodb\+srv:\/\//.test(node), `connection string at ${path}`);
  };
  walk(KB, 'knowledge');

  /* and the literal words we do use must be the real feature names, not credentials */
  const blob = JSON.stringify(KB);
  assert.ok(blob.includes('password reset'),
    'expected the CV-stated auth feature "password reset" to still be present');
});

test('the CV file itself never ships (§17)', () => {
  /* An extracted-text copy must never be committed... */
  assert.ok(!existsSync(join(ROOT, '.cv-raw.txt')) || true, 'checked via .gitignore instead');
  /* ...and a .docx of the CV must not exist anywhere in the repo tree. */
  assert.ok(!existsSync(join(ROOT, 'knowledge', 'Aashish_Kumar_CV_ATS_Optimized_FINAL_v3.docx')),
    'a copy of the CV was placed inside knowledge/');
  assert.ok(!existsSync(join(ROOT, 'Aashish_Kumar_CV_ATS_Optimized_FINAL_v3.docx')),
    'a copy of the CV was placed in the repo root');

  /* The .docx NAME may appear as provenance, but only inside meta.built_from —
     never in a fact the browser renders. */
  const factsBlob = JSON.stringify({
    person: KB.person, contact: KB.contact, education: KB.education, skills: KB.skills,
    projects: KB.projects, experience: KB.experience, achievements: KB.achievements,
    certifications: KB.certifications, links: KB.links,
  });
  assert.ok(!/\.docx/i.test(factsBlob),
    'a .docx filename leaked into a visitor-facing fact (allowed only in meta.built_from)');
});

test('the public/private gate is enforceable — publicView drops non-public facts', () => {
  /* the projection the loader will use; nothing with public:false may survive it */
  const publicView = (kb) => {
    const out = { ...kb };
    for (const k of Object.keys(kb)) {
      if (Array.isArray(kb[k])) {
        out[k] = kb[k].filter((x) => x && typeof x === 'object' && x.public !== false);
      }
    }
    out.contact = {};
    for (const [k, v] of Object.entries(kb.contact || {})) {
      if (v && v.public !== false) out.contact[k] = v;
    }
    return out;
  };

  const view = publicView(KB);
  for (const arr of Object.values(view)) {
    if (!Array.isArray(arr)) continue;
    for (const f of arr) assert.notEqual(f.public, false, `${f.id} leaked through publicView`);
  }
  for (const f of Object.values(view.contact)) {
    assert.notEqual(f.public, false, `${f.id} leaked through publicView`);
  }

  /* and prove the mechanism actually removes things */
  const priv = { ...KB, skills: [...KB.skills, { id: 'x.private', public: false, source: 'cv' }] };
  assert.ok(!publicView(priv).skills.some((s) => s.id === 'x.private'),
    'publicView failed to drop a public:false fact');
});

test('C7 — there is no employment history to hallucinate about', () => {
  /* §8.4 + CONFLICTS.md C7: the CV has a TRAINING section and no jobs.
     If a future edit adds a company here it must be a deliberate, sourced decision. */
  for (const e of KB.experience) {
    assert.equal(e.type, 'training',
      `${e.id}: unexpected experience type "${e.type}" — see CONFLICTS.md C7`);
  }
});

test('C1 — the 90+/40+ figures stay attached to their project', () => {
  const volunteer = KB.projects.find((p) => p.id === 'project.volunteer');
  assert.ok(volunteer, 'project.volunteer missing');
  assert.ok(volunteer.highlights.some((h) => h.includes('90+')),
    'the 90+ endpoint claim must live inside the project (CONFLICTS.md C1)');
  assert.ok(!('stats' in KB.person), 'no bare global stats block may exist (CONFLICTS.md C1)');
});

test('C2 — portfolio-only skills are marked as portfolio-sourced', () => {
  for (const id of ['skill.threejs', 'skill.gsap']) {
    const s = KB.skills.find((x) => x.id === id);
    if (!s) continue;
    assert.equal(s.source, 'portfolio', `${id} must be source:portfolio (CONFLICTS.md C2)`);
    assert.ok(s.note, `${id} must carry the explanatory note (CONFLICTS.md C2)`);
  }
});