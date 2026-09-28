"""training/scripts/make_seed_corpus.py — the local dev corpus.

    python -m training.scripts.make_seed_corpus

WHAT THIS IS NOT: the Stage A training corpus. §7.3's real sources
(AI4Bharat Sangraha, Hindi Wikipedia, L3Cube-HingCorpus, curated simple
English) are licensed, downloaded and recorded in `docs/DATA_LICENSES.md`
during P4. None of that is fetched here, and nothing in this file is
claimed to be quality training data.

WHAT THIS IS: a deterministic, ours-only fixture (we wrote every line, so
the licence question is trivial) big enough to exercise the pipeline end
to end — clean → normalize → dedupe → language-ID → filter → tokenize →
shard — and to give the tokenizer a real vocab with real fertility
numbers for EN / HI / Hinglish / tech. It also deliberately contains the
public project URL, so the PII-to-placeholder rule (§7.2) is exercised
rather than assumed.

Output: `data/raw/seed/*.txt`, one line per example.
"""

from __future__ import annotations

import argparse
import random
import sys
from pathlib import Path

if __package__ in (None, ""):
    sys.path.insert(0, str(Path(__file__).resolve().parents[2]))

from ai.tokenizer import spec  # noqa: E402

OUT_DIR = spec.REPO_ROOT / "data" / "raw" / "seed"
SEED = 20260920

# ── English: simple, clean, conversational (TinyStories framing) ─────
EN_SUBJECTS = ["Aashish", "the developer", "the assistant", "the student",
               "the recruiter", "the reviewer", "the mentor", "the team"]
EN_QUESTIONS = [
    "What projects has {s} built?",
    "Can you show me {s} education details?",
    "Which databases does {s} work with?",
    "How can I contact {s}?",
    "Tell me about the strongest project {s} shipped.",
    "What does {s} do day to day at work?",
    "Is {s} available for a full-time role?",
    "Which frontend framework does {s} prefer and why?",
    "How many API endpoints did {s} design for the community platform?",
    "What was {s} role in the grocery application?",
]
EN_ANSWERS = [
    "{s} designed the product, the data model and the interface, then directed AI tools to implement it to spec.",
    "The verified record shows a Bachelor of Technology in Computer Science with a CGPA of 8.28.",
    "The stack includes React, Vite, Tailwind CSS, Node.js, Express and MySQL with Drizzle ORM.",
    "I only answer from Aashish's verified portfolio, so I will say when something is not recorded.",
    "The work was reviewed and corrected by hand before it was published, which is why the details are specific.",
    "It is a small assistant that reads a fixed knowledge base and copies facts instead of inventing them.",
]
EN_PASSAGES = [
    ("Maya found a small robot in the garden. The robot could water one plant at a time, "
     "so Maya put it next to the tomatoes and watched it work all afternoon.",
     "What could the robot do?", "The robot could water one plant at a time."),
    ("The library closed early because the storm knocked the power out. Ravi walked home "
     "with three books under his coat and read them by candlelight.",
     "Why did the library close early?", "The storm knocked the power out."),
    ("Aashish built a volunteer management system with ninety API endpoints across sixteen "
     "route groups and forty database tables. He wrote the product spec first, then directed "
     "AI tools to build it, and reviewed every change himself.",
     "How many endpoint groups were mounted?", "Sixteen route groups were mounted."),
    ("The tokenizer was trained from scratch on our own corpus. It uses byte-level BPE with "
     "NFC normalization, so every script is representable and there is no unknown token.",
     "Why is there no unknown token?", "Byte-level BPE can represent every byte."),
]

# ── Hindi (Devanagari) ───────────────────────────────────────────────
HI_QUESTIONS = [
    "आशीष का सबसे मजबूत प्रोजेक्ट कौन सा है?",
    "उसने कौन सी डेटाबेस का इस्तेमाल किया?",
    "उसकी पढ़ाई के बारे में बताइए।",
    "क्या आप उसका संपर्क पता बता सकते हैं?",
    "उसने कितने एपीआई एंडपॉइंट बनाए?",
    "वह किस तरह के काम में रुचि रखता है?",
    "उसका सीजीपीए कितना है?",
    "आप कौन सी भाषा में जवाब देते हैं?",
    "उसके कौशल के बारे में विस्तार से बताइए।",
    "क्या वह पूर्णकालिक नौकरी के लिए उपलब्ध है?",
    "उसने किन परियोजनाओं पर काम किया है?",
    "उसका पसंदीदा फ्रेमवर्क कौन सा है और क्यों?",
]
HI_ANSWERS = [
    "मैं केवल सत्यापित जानकारी के आधार पर उत्तर देता हूँ।",
    "यह जानकारी अभी आशीष के पोर्टफोलियो में उपलब्ध नहीं है।",
    "उसने सामुदायिक स्वयंसेवा प्रबंधन प्रणाली पर काम किया और नब्बे से अधिक एपीआई एंडपॉइंट बनाए।",
    "उसकी तकनीकी सूची में रिएक्ट, नोड डॉट जेएस, मंगोडीबी और मायएसक्यूएल शामिल हैं।",
    "उसने बी.टेक की पढ़ाई लवली प्रोफेशनल यूनिवर्सिटी से पूरी की और उसका सीजीपीए 8.28 है।",
    "मैं हिंदी, अंग्रेज़ी और हिंग्लिश तीनों में जवाब दे सकता हूँ।",
    "पहले उसने आवश्यकताएँ लिखीं, फिर डेटा मॉडल बनाया और अंत में इंटरफ़ेस तैयार किया।",
    "यह परियोजना एक ही कोड आधार में फ्रंटएंड और बैकएंड दोनों को जोड़ती है।",
    "उसने हर बदलाव की समीक्षा स्वयं की और गलतियाँ ठीक कीं।",
    "उपयोगकर्ता की निजी जानकारी साझा नहीं की जाती, इसलिए मैं केवल सार्वजनिक तथ्य बताता हूँ।",
]
HI_STORIES = [
    "सुबह की धूप खिड़की से आ रही थी और मीरा ने अपनी कॉपी खोलकर पहला सवाल हल किया।",
    "बारिश तेज़ थी, इसलिए राहुल ने छाता लिया और स्टेशन की ओर चल पड़ा।",
    "गाँव के बच्चों ने मिलकर एक छोटा पुस्तकालय बनाया और हर शनिवार वहाँ कहानियाँ पढ़ीं।",
    "आशीष ने अपने कंप्यूटर पर एक छोटा सहायक बनाया जो केवल सत्यापित जानकारी बताता है।",
]

# ── Roman Hinglish ───────────────────────────────────────────────────
HING_QUESTIONS = [
    "uska strongest project kaun sa hai?",
    "usne kaun sa database use kiya tha?",
    "uski padhai ke baare mein batao na",
    "contact details bata do yaar",
    "kitne api endpoints banaye usne?",
    "cgpa kitna hai uska?",
    "ye assistant kaun si language mein jawab deta hai?",
    "uska github profile dikhao",
    "uske skills ke baare mein thoda detail mein batao",
    "kya wo full time ke liye available hai?",
    "usne kaun kaun se projects banaye hain?",
    "uska favourite framework kaun sa hai aur kyun?",
]
HING_ANSWERS = [
    "Main sirf verified portfolio data se hi jawab deta hun, kuch bhi bana ke nahi bolta.",
    "Ye information abhi Aashish ke portfolio mein available nahi hai.",
    "Usne community volunteer management system banaya jismein 90+ api endpoints hain.",
    "Uska stack React, Node.js, Express, MongoDB aur MySQL ke aas paas hai.",
    "Uska CGPA 8.28 hai aur B.Tech Lovely Professional University se kiya hai.",
    "Main English, Hindi aur Hinglish teeno samajhta hun, tum jis bhasha mein pucho usi mein jawab deta hun.",
    "Usne pehle requirements likhi, phir data model banaya aur last mein UI tayyar kiya.",
    "Ye project ek hi codebase mein frontend aur backend dono ko jodta hai.",
    "Usne har change ko khud review kiya aur galtiyan theek ki.",
    "Private information share nahi hoti, isliye main sirf public facts batata hun.",
]
HING_CHAT = [
    "bhai ye project accha lag raha hai, ismein kaam kya kya hua?",
    "haan theek hai, ab thoda detail mein batao",
    "arre ye toh mast hai, aur kuch dikhao",
    "nahi yaar, mujhe sirf verified cheezein chahiye",
    "accha, matlab ye sab AI ne likha tha?",
    "chalo, ab uska workflow samjhao thoda",
]

# ── Tech / code (tokenizer must handle these without bloating) ───────
TECH_TERMS = [
    "React 18", "Vite", "Tailwind CSS", "Node.js", "Express", "MongoDB", "MySQL",
    "Drizzle ORM", "Prisma", "JWT", "RBAC", "Argon2", "bcrypt", "Helmet", "Zod",
    "Recharts", "npm workspaces", "REST API", "GraphQL", "WebSocket", "SSE",
    "IndexedDB", "OPFS", "Service Worker", "COOP", "COEP", "SharedArrayBuffer",
    "WebAssembly", "SIMD", "WebGPU", "ONNX Runtime Web", "Transformers.js", "wllama",
    "llama.cpp", "GGUF", "INT8", "INT4", "Q4_0", "fp16", "bfloat16", "AMP", "GradScaler",
    "RMSNorm", "RoPE", "SwiGLU", "GQA", "KV cache", "SDPA", "FlashAttention",
    "BM25", "char n-gram", "Jaccard", "Memmap", "AdamW", "cosine schedule", "warmup",
    "GSAP", "Lenis", "Three.js", "requestAnimationFrame", "IntersectionObserver",
    "GitHub Actions", "Netlify", "Vercel", "Docker", "Kubernetes", "Nginx", "Redis",
]
CODE_LINES = [
    "SELECT id, created_at FROM users WHERE role = 'admin' ORDER BY created_at DESC LIMIT 20;",
    "const [state, setState] = useState(() => loadFromCache(key));",
    "export function detectLanguage(text) { return rules(text.toLowerCase()); }",
    "SELECT p.name, COUNT(e.id) AS endpoints FROM projects p JOIN endpoints e ON e.project_id = p.id GROUP BY p.id;",
    "npm run build && node --experimental-modules dist/index.mjs --port=5173",
    "docker compose up -d --build",
    "git rebase --interactive origin/main",
    "curl -X POST http://localhost:5577/api/contact -H 'Content-Type: application/json' -d @payload.json",
    "for (let i = 0; i < tokens.length; i += blockSize) { yield tokens.subarray(i, i + blockSize); }",
    "class RMSNorm(nn.Module): def forward(self, x): return x * torch.rsqrt(x.pow(2).mean(-1, keepdim=True) + self.eps)",
    "def apply_rope(x, cos, sin): return (x * cos) + (rotate_half(x) * sin)",
    "attention_mask = torch.triu(torch.full((n, n), float('-inf')), diagonal=1)",
    "loss = F.cross_entropy(logits.view(-1, vocab), targets.view(-1), ignore_index=-100)",
    "np.memmap(path, dtype=np.uint16, mode='r')",
    "scheduler = get_cosine_schedule_with_warmup(optimizer, warmup_steps, total_steps)",
    "await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });",
    "if (typeof SharedArrayBuffer === 'undefined') fallbackToSingleThread();",
    "Cache-Control: public, max-age=31536000, immutable",
    "sha256: 3f9a21c0b7de9d1e5a7c4b2f8e6d0a3c5b7d9f1e2a4c6b8d0f2e4a6c8b0d2f4e",
    "GET /api/v1/projects?limit=20&cursor=eyJpZCI6MTIzfQ==",
]

# ── Programmatic simple sentences ────────────────────────────────────
# Volume has to come from somewhere if the tokenizer is to be trained at
# a real vocabulary size offline. These are grammatical slot fills, not
# a language model's output: every frame is hand-written, and the Hindi
# and Hinglish object/verb slots are stored as *pairs* (किताब/पढ़ी) so
# agreement cannot break when the slots are crossed.
EN_NAMES = ["Maya", "Ravi", "Aashish", "Neha", "Arjun", "Simran", "Kabir", "Tara"]
EN_NOUNS = ["robot", "garden", "library", "bicycle", "teacher", "village",
            "engineer", "notebook", "bridge", "market", "river", "student"]
EN_OBJS = ["books", "tomatoes", "letters", "photographs", "water",
           "music", "tools", "seeds", "numbers", "stories"]
EN_VPAST = ["found", "carried", "painted", "repaired", "counted", "wrote",
            "watched", "collected", "measured", "shared"]
EN_VPAST2 = ["smiled", "waited", "returned", "laughed", "hurried", "rested"]
EN_VPRES = ["reads", "builds", "fixes", "carries", "studies", "measures"]
EN_VINF = ["climb", "repair", "sort", "sketch", "measure", "plant", "explain"]
EN_PLACES = ["garden", "library", "workshop", "village", "market",
             "classroom", "station", "kitchen"]
EN_DAYS = ["morning", "evening", "Monday", "weekend", "afternoon", "night"]
EN_FRAMES = [
    "The {noun} {vpast} the {obj} in the {place}.",
    "{name} {vpast} the {obj} and then {vpast2} near the {place}.",
    "Every {day}, {name} {vpres} the {obj} beside the {place}.",
    "{name} wanted to {vinf} the {obj}, so the {noun} helped quietly.",
    "After the {noun} {vpast} the {obj}, {name} wrote it down in the {place}.",
    "The {noun} {vpast} the {obj} again, and the {place} stayed calm.",
]

HI_NAMES = ["आशीष", "मीरा", "राहुल", "नीरज", "सानिया", "कबीर", "आरती", "दीपक"]
HI_PAIRS = [("किताब", "पढ़ी"), ("खाना", "बनाया"), ("गाना", "सुना"),
            ("पानी", "पिया"), ("चित्र", "बनाया"), ("पत्र", "लिखा"),
            ("साइकिल", "चलाई"), ("कहानी", "सुनाई")]
HI_PLACES = ["गाँव", "स्कूल", "बाज़ार", "पुस्तकालय", "घर", "बगीचा", "स्टेशन"]
HI_FRAMES = [
    "{name} ने {obj} {verb}।",
    "{name} ने कल {obj} {verb} और फिर घर लौट गया।",
    "{place} में {name} ने {obj} {verb}।",
    "जब {name} छोटा था तब उसने {obj} {verb}।",
    "सुबह की धूप में {name} ने {obj} {verb}।",
]
HI_FILLER = [
    "यह कहानी सरल और साफ़ भाषा में लिखी गई है।",
    "मैं केवल सत्यापित जानकारी के आधार पर उत्तर देता हूँ।",
    "उसने पहले योजना बनाई और फिर काम शुरू किया।",
    "हर शनिवार बच्चे पुस्तकालय में कहानियाँ पढ़ते हैं।",
    "बारिश के बाद हवा ठंडी और सुगंधित हो गई।",
]

HING_NAMES = ["Aashish", "Meera", "Rahul", "Niraj", "Sania", "Kabir", "Arti", "Deepak"]
HING_PAIRS = [("kitab", "padhi"), ("khana", "banaya"), ("gaana", "suna"),
              ("pani", "piya"), ("photo", "kheenchi"), ("cycle", "chalayi"),
              ("kahani", "sunai"), ("note", "likha")]
HING_PLACES = ["gaon", "school", "bazaar", "library", "ghar", "bagicha", "station"]
HING_FRAMES = [
    "{name} ne {obj} {verb}.",
    "{name} ne kal {obj} {verb} aur phir ghar chala gaya.",
    "{place} mein {name} ne {obj} {verb}.",
    "Jab {name} chhota tha tab usne {obj} {verb}.",
    "Subah {name} ne {obj} {verb}, phir kaam par nikal gaya.",
]

ASSISTANT_FRAMES = [
    "{q} → {a}",
    "Q: {q}\nA: {a}",
    "<|user|> {q} <|asst|> {a} <|end|>",
    "<|sys|> Answer only from the verified portfolio. <|user|> {q} <|asst|> {a} <|end|>",
]
CONTEXT_FRAMES = [
    "<|ctx|> {p} <|user|> {q} <|asst|> {a} <|end|>",
    "Passage: {p}\nQuestion: {q}\nAnswer: {a}",
]


def _fill(template: str, rng: random.Random, names, nouns=(), objs=(),
          vpast=(), vpast2=(), vpres=(), vinf=(), places=(), days=(),
          pairs=()) -> str:
    """One grammatical slot fill. Hindi/Hinglish use `pairs` so the
    object and its agreeing verb always travel together."""
    def pick(options, fallback: str) -> str:
        return rng.choice(options) if options else fallback

    values = {
        "name": pick(names, "Aashish"), "noun": pick(nouns, "robot"),
        "obj": pick(objs, "books"), "vpast": pick(vpast, "found"),
        "vpast2": pick(vpast2, "smiled"), "vpres": pick(vpres, "reads"),
        "vinf": pick(vinf, "repair"), "place": pick(places, "garden"),
        "day": pick(days, "morning"),
    }
    if pairs:
        values["obj"], values["verb"] = rng.choice(pairs)
    return template.format(**values)


def generate_paragraphs(frames, rng, count, names, sentences=3, **slots) -> list[str]:
    """`count` short paragraphs, one line each.

    Paragraphs rather than isolated sentences because a tokenizer trained
    on single sentences learns nothing about how turns run together — and
    the smoke model's block size needs text that long.
    """
    out = []
    for _ in range(count):
        lines = [_fill(rng.choice(frames), rng, names, **slots) for _ in range(sentences)]
        out.append(" ".join(lines))
    return out


def _expand(frames, pairs, rng, limit=None):
    """frame × (question, answer) → one line per example.

    Newlines inside a frame are collapsed: the corpus is read back line by
    line, so a multi-line example would arrive as several *records* — the
    question and the answer would train as unrelated sentences.
    """
    out = []
    for frame in frames:
        for q, a in pairs:
            out.append(" ".join(frame.format(q=q, a=a).split()))
    rng.shuffle(out)
    return out[:limit] if limit else out


def build_files(seed: int = SEED) -> dict[str, list[str]]:
    rng = random.Random(seed)

    en_pairs = [(q.format(s=s), a.format(s=s))
                for q in EN_QUESTIONS for s in EN_SUBJECTS for a in EN_ANSWERS]
    en = _expand(ASSISTANT_FRAMES, en_pairs, rng)

    hi_pairs = [(q, a) for q in HI_QUESTIONS for a in HI_ANSWERS] + \
               [(s, "यह एक सरल वाक्य है जो साफ़ भाषा में लिखा गया है।") for s in HI_STORIES]
    hi = _expand(ASSISTANT_FRAMES[:3], hi_pairs, rng)

    hing_pairs = [(q, a) for q in HING_QUESTIONS for a in HING_ANSWERS] + \
                 [(c, "theek hai, main sirf verified data se jawab dunga") for c in HING_CHAT]
    hing = _expand(ASSISTANT_FRAMES[:3], hing_pairs, rng)

    tech: list[str] = []
    for i in range(0, len(TECH_TERMS) - 5, 6):
        tech.append(", ".join(TECH_TERMS[i:i + 6]) + ".")
    tech += CODE_LINES * 4
    tech += [f"install {t} and pin the version in package.json" for t in TECH_TERMS[:40]]
    tech += [f"{t} works the same way in the browser and in the worker." for t in TECH_TERMS[:30]]

    ctx = [" ".join(f.format(p=p, q=q, a=a).split())
           for p, q, a in EN_PASSAGES
           for f in CONTEXT_FRAMES]

    # Volume so the tokenizer can be trained at a real vocab size offline.
    # Counts are sized to what a 4k BPE needs (roughly 650 bytes per merge
    # before `min_frequency=2` runs out of distinct pairs): the trainer
    # *refuses* to emit a vocab the corpus cannot justify, so too little
    # text is a loud failure, not a quiet one.
    synth_en = generate_paragraphs(EN_FRAMES, rng, 7000, EN_NAMES, nouns=EN_NOUNS,
                                   objs=EN_OBJS, vpast=EN_VPAST, vpast2=EN_VPAST2,
                                   vpres=EN_VPRES, vinf=EN_VINF,
                                   places=EN_PLACES, days=EN_DAYS)
    synth_hi = generate_paragraphs(HI_FRAMES, rng, 3800, HI_NAMES, pairs=HI_PAIRS,
                                   places=HI_PLACES)
    synth_hi += [_fill(" ".join(rng.sample(HI_FILLER, 2)), rng, HI_NAMES)
                 for _ in range(600)]
    synth_hing = generate_paragraphs(HING_FRAMES, rng, 3800, HING_NAMES,
                                     pairs=HING_PAIRS, places=HING_PLACES)

    # Public facts, written verbatim on purpose: the pipeline must turn
    # them into placeholders rather than let the model learn to type them.
    portfolio = [
        "The community volunteer application runs at https://atlascommunity-one.vercel.app/ and "
        "the grocery application has its own live deployment.",
        "The profile at https://github.com/ links to the same projects shown in the portfolio.",
        "When someone asks for the live demo, answer with the project placeholder and not the raw link.",
    ]

    return {
        "conv_en.txt": en,
        "conv_hi.txt": hi,
        "conv_hinglish.txt": hing,
        "tech_code.txt": tech,
        "copy_from_context.txt": ctx,
        "portfolio_refs.txt": portfolio,
        "synth_en.txt": synth_en,
        "synth_hi.txt": synth_hi,
        "synth_hinglish.txt": synth_hing,
    }


def write_corpus(out_dir: Path = OUT_DIR, seed: int = SEED) -> dict[str, int]:
    out_dir.mkdir(parents=True, exist_ok=True)
    counts: dict[str, int] = {}
    for name, lines in build_files(seed).items():
        unique = list(dict.fromkeys(lines))  # exact dupes only; near-dup is the pipeline's job
        (out_dir / name).write_text("\n".join(unique) + "\n", encoding="utf-8")
        counts[name] = len(unique)
    return counts


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(
        prog="python -m training.scripts.make_seed_corpus",
        description="Write the deterministic dev corpus to data/raw/seed/*.txt (the P3 "
                    "fixture, not the Stage A corpus).",
    )
    p.add_argument("--out", type=Path, default=OUT_DIR,
                   help="directory to write the *.txt files into")
    p.add_argument("--seed", type=int, default=SEED,
                   help="RNG seed; the default reproduces the committed fixture exactly")
    return p


def main(argv: list[str] | None = None) -> int:
    # Windows consoles default to cp1252 and this module's output is not cp1252
    # ("→"): the arrow killed the process on the one platform the fixture is
    # built on. Every script in training/scripts does this, which is why
    # `--help` is part of the notebook test's checks.
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")

    args = build_parser().parse_args(argv)
    counts = write_corpus(args.out, args.seed)
    total = sum(counts.values())
    print(f"seed corpus → {args.out}")
    for name, count in counts.items():
        print(f"  {name:<22} {count:>5} lines")
    print(f"  {'total':<22} {total:>5} lines")
    print("\nThis is the P3 dev fixture, not the Stage A corpus (§7.3, P4).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
