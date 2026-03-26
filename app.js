const ROUTE_SIZE = 12;
const CAPSTONE_BATCH_SIZE = 20;
const STORAGE_KEY = "word-queue-english-progress-v1";

const app = document.querySelector("#app");

const state = {
  course: null,
  practiceSequence: [],
  capstonePool: [],
  routeCount: 0,
  progress: null,
  previewLobby: false,
  resultView: null,
  audio: {
    context: null,
  },
  ui: {
    questionKey: null,
    selection: [],
    feedback: null,
    pendingAdvance: false,
  },
  flash: null,
  error: null,
};

const CATEGORY_PRIORITY = {
  lexical: 0,
  irregularForm: 1,
  properNoun: 2,
  grammar: 3,
  fullSentence: 4,
};

const GATE_COPY = {
  pick: {
    label: "Pick Gate",
    kicker: "Quick match",
    prompt: "Pick the English item that matches the hint.",
  },
  build: {
    label: "Build Gate",
    kicker: "Chunk by chunk",
    prompt: "Tap the right pieces to build the target.",
  },
  fix: {
    label: "Fix Gate",
    kicker: "Repair the lane",
    prompt: "Spot the broken piece and fix the word.",
  },
  sentence: {
    label: "Sentence Gate",
    kicker: "Final lane",
    prompt: "Choose the best word or phrase to complete the sentence.",
  },
};

app.addEventListener("click", handleClick);

boot();

async function boot() {
  renderLoading("Warming up the queue...");

  try {
    const payload = await loadCourse();
    state.course = payload;
    state.practiceSequence = buildPracticeSequence(payload.items.filter((item) => item.practiceEligible));
    state.capstonePool = payload.items.filter((item) => item.capstoneEligible && item.capstoneTarget);
    state.routeCount = Math.ceil(state.practiceSequence.length / ROUTE_SIZE);
    state.progress = loadProgress();
    sanitizeProgress();
    render();
  } catch (error) {
    state.error = error;
    renderError(error);
  }
}

async function loadCourse() {
  if (window.WORD_QUEUE_COURSE) {
    return window.WORD_QUEUE_COURSE;
  }

  const response = await fetch("./data/course.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Unable to load course data: ${response.status}`);
  }
  return response.json();
}

function defaultProgress() {
  return {
    practicedIds: [],
    masteredIds: [],
    routeIndex: 0,
    activeMode: "lobby",
    activeRouteIndex: null,
    activeQuestionIndex: 0,
    currentStreak: 0,
    bestStreak: 0,
    stickers: 0,
    capstoneQueue: [],
    capstoneCurrentBatchIds: [],
    capstoneQuestionIndex: 0,
    capstoneCompletedBatches: 0,
  };
}

function loadProgress() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (!parsed) {
      return defaultProgress();
    }
    return { ...defaultProgress(), ...parsed };
  } catch {
    return defaultProgress();
  }
}

function saveProgress() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state.progress));
}

function sanitizeProgress() {
  const itemIds = new Set(state.course.items.map((item) => item.id));

  state.progress.practicedIds = state.progress.practicedIds.filter((id) => itemIds.has(id));
  state.progress.masteredIds = state.progress.masteredIds.filter((id) => itemIds.has(id));
  state.progress.capstoneQueue = state.progress.capstoneQueue.filter((id) => itemIds.has(id));
  state.progress.capstoneCurrentBatchIds = state.progress.capstoneCurrentBatchIds.filter((id) => itemIds.has(id));

  state.progress.routeIndex = clamp(state.progress.routeIndex, 0, state.routeCount);
  if (state.progress.activeRouteIndex !== null) {
    state.progress.activeRouteIndex = clamp(state.progress.activeRouteIndex, 0, Math.max(state.routeCount - 1, 0));
  }

  if (state.progress.activeMode === "practice") {
    if (state.progress.activeRouteIndex === null || state.progress.routeIndex >= state.routeCount) {
      state.progress.activeMode = "lobby";
      state.progress.activeRouteIndex = null;
      state.progress.activeQuestionIndex = 0;
    } else {
      const routeItems = getRouteItems(state.progress.activeRouteIndex);
      if (!routeItems.length) {
        state.progress.activeMode = "lobby";
        state.progress.activeRouteIndex = null;
        state.progress.activeQuestionIndex = 0;
      } else if (state.progress.activeQuestionIndex >= routeItems.length) {
        state.progress.activeQuestionIndex = 0;
      }
    }
  }

  if (state.progress.activeMode === "capstone") {
    if (!state.progress.capstoneCurrentBatchIds.length) {
      state.progress.activeMode = "lobby";
      state.progress.capstoneQuestionIndex = 0;
    } else if (state.progress.capstoneQuestionIndex >= state.progress.capstoneCurrentBatchIds.length) {
      state.progress.capstoneQuestionIndex = 0;
    }
  }

  saveProgress();
}

function buildPracticeSequence(items) {
  const words = [];
  const phrases = [];

  const sorted = [...items].sort((left, right) => {
    const categoryDelta = CATEGORY_PRIORITY[left.category] - CATEGORY_PRIORITY[right.category];
    if (categoryDelta !== 0) {
      return categoryDelta;
    }
    const difficultyDelta = left.difficultyRank - right.difficultyRank;
    if (difficultyDelta !== 0) {
      return difficultyDelta;
    }
    return left.text.localeCompare(right.text);
  });

  sorted.forEach((item) => {
    if (item.itemType === "phrase") {
      phrases.push(item);
    } else {
      words.push(item);
    }
  });

  const sequence = [];
  while (words.length || phrases.length) {
    if (sequence.length % 3 === 2 && phrases.length) {
      sequence.push(phrases.shift());
    } else if (words.length) {
      sequence.push(words.shift());
    } else if (phrases.length) {
      sequence.push(phrases.shift());
    }
  }
  return sequence;
}

function getRouteItems(routeIndex) {
  const start = routeIndex * ROUTE_SIZE;
  return state.practiceSequence.slice(start, start + ROUTE_SIZE);
}

function getCurrentPracticeQuestion() {
  const routeItems = getRouteItems(state.progress.activeRouteIndex);
  const item = routeItems[state.progress.activeQuestionIndex];
  if (!item) {
    return null;
  }
  const globalIndex = state.progress.activeRouteIndex * ROUTE_SIZE + state.progress.activeQuestionIndex;
  return createPracticeQuestion(item, globalIndex);
}

function createPracticeQuestion(item, globalIndex) {
  const template = choosePracticeTemplate(item, globalIndex);
  if (template === "build") {
    return createBuildQuestion(item, globalIndex);
  }
  if (template === "fix") {
    return createFixQuestion(item, globalIndex);
  }
  return createPickQuestion(item, globalIndex, state.practiceSequence);
}

function choosePracticeTemplate(item, globalIndex) {
  if (item.category !== "lexical") {
    return "pick";
  }

  const search = normalizeText(item.searchText);
  const isCleanWord = item.itemType === "word" && /^[a-z']+$/i.test(search) && search.length >= 4;
  const isPhraseBuildable =
    item.itemType === "phrase" &&
    search.split(" ").length <= 3 &&
    /^[a-z'\s-]+$/i.test(search);

  const slot = globalIndex % 3;
  if (slot === 1 && (isCleanWord || isPhraseBuildable)) {
    return "build";
  }
  if (slot === 2 && isCleanWord) {
    return "fix";
  }
  return "pick";
}

function createPickQuestion(item, globalIndex, pool) {
  const rng = seededRng(`pick:${item.id}:${globalIndex}`);
  const distractors = getDistractors(item, pool, 2, rng, {
    itemType: item.itemType,
    includeCategory: false,
  });
  const options = seededShuffle([item, ...distractors], rng).map((option) => ({
    id: option.id,
    label: option.text,
  }));

  return {
    key: `pick:${item.id}:${globalIndex}`,
    type: "pick",
    item,
    options,
    correctId: item.id,
  };
}

function createBuildQuestion(item, globalIndex) {
  const rng = seededRng(`build:${item.id}:${globalIndex}`);
  const target = normalizeText(item.searchText);

  if (item.itemType === "phrase") {
    const words = target.split(" ");
    const distractorWords = getDistractors(item, state.practiceSequence, 2, rng, {
      itemType: "phrase",
      includeCategory: false,
    })
      .flatMap((entry) => normalizeText(entry.searchText).split(" "))
      .filter((word) => word && !words.includes(word))
      .slice(0, 2);

    const tokens = buildOrderedTokenBank(words, distractorWords, rng);

    return {
      key: `build:${item.id}:${globalIndex}`,
      type: "build",
      item,
      correctTokenIds: words.map((_, index) => `core-${index}`),
      tokens,
      separator: " ",
      hint: `${words.length} blocks`,
    };
  }

  const chunks = splitWordIntoChunks(target);
  if (chunks.length < 2) {
    return createPickQuestion(item, globalIndex, state.practiceSequence);
  }

  const distractors = generateDistractorChunks(target, rng, chunks.length === 2 ? 1 : 2);
  const tokens = buildOrderedTokenBank(chunks, distractors, rng);

  return {
    key: `build:${item.id}:${globalIndex}`,
    type: "build",
    item,
    correctTokenIds: chunks.map((_, index) => `core-${index}`),
    tokens,
    separator: "",
    hint: `${chunks.length} chunks`,
  };
}

function createFixQuestion(item, globalIndex) {
  const rng = seededRng(`fix:${item.id}:${globalIndex}`);
  const target = normalizeText(item.searchText);
  const letters = target.split("");
  const indices = letters
    .map((char, index) => (/^[a-z]$/i.test(char) ? index : -1))
    .filter((index) => index >= 0);

  if (indices.length < 3) {
    return createPickQuestion(item, globalIndex, state.practiceSequence);
  }

  const index = indices[Math.floor(rng() * indices.length)];
  const correctPiece = letters[index];
  const useMissing = rng() > 0.45;
  const choices = seededShuffle(
    [
      correctPiece,
      ...generateLetterDistractors(correctPiece, rng, 2),
    ],
    rng,
  );

  const display = [...letters];
  let helper = "One letter is wrong.";
  if (useMissing) {
    display[index] = "_";
    helper = "One letter is missing.";
  } else {
    display[index] = generateLetterDistractors(correctPiece, rng, 1)[0];
  }

  return {
    key: `fix:${item.id}:${globalIndex}`,
    type: "fix",
    item,
    display,
    correctPiece,
    choices,
    helper,
  };
}

function getCurrentCapstoneQuestion() {
  const item = state.course.items.find((entry) => entry.id === state.progress.capstoneCurrentBatchIds[state.progress.capstoneQuestionIndex]);
  if (!item) {
    return null;
  }

  const sentence = blankExample(item.example, item.capstoneTarget);
  if (!sentence) {
    return null;
  }

  const rng = seededRng(`sentence:${item.id}:${state.progress.capstoneQuestionIndex}`);
  const distractors = getDistractors(item, state.capstonePool, 2, rng, {
    itemType: item.itemType,
    includeCategory: false,
  });
  const options = seededShuffle([item, ...distractors], rng).map((option) => ({
    id: option.id,
    label: option.text,
  }));

  return {
    key: `sentence:${item.id}:${state.progress.capstoneQuestionIndex}`,
    type: "sentence",
    item,
    sentence,
    options,
    correctId: item.id,
  };
}

function getDistractors(correctItem, pool, count, rng, options = {}) {
  const scored = pool
    .filter((candidate) => candidate.id !== correctItem.id)
    .filter((candidate) => !options.itemType || candidate.itemType === options.itemType)
    .map((candidate) => ({ candidate, score: similarityScore(correctItem, candidate) }))
    .sort((left, right) => right.score - left.score || left.candidate.text.localeCompare(right.candidate.text));

  const shortlist = scored.slice(0, Math.max(8, count * 4)).map((entry) => entry.candidate);
  return seededShuffle(shortlist, rng).slice(0, count);
}

function similarityScore(reference, candidate) {
  let score = 0;
  if (reference.itemType === candidate.itemType) score += 4;
  if (reference.category === candidate.category) score += 3;
  if (reference.difficultyRank === candidate.difficultyRank) score += 3;
  if (Math.abs(reference.text.length - candidate.text.length) <= 2) score += 2;
  if (normalizeText(reference.searchText).charAt(0) === normalizeText(candidate.searchText).charAt(0)) score += 1;
  return score;
}

function splitWordIntoChunks(word) {
  const clean = word.replace(/[^a-z']/gi, "");
  if (clean.length <= 4) {
    return [clean.slice(0, 2), clean.slice(2)].filter(Boolean);
  }
  if (clean.length <= 6) {
    return [clean.slice(0, 2), clean.slice(2, 4), clean.slice(4)].filter(Boolean);
  }
  if (clean.length <= 9) {
    return [clean.slice(0, 3), clean.slice(3, 6), clean.slice(6)].filter(Boolean);
  }
  return [clean.slice(0, 3), clean.slice(3, 7), clean.slice(7)].filter(Boolean);
}

function generateDistractorChunks(word, rng, count) {
  const clean = normalizeText(word).replace(/[^a-z']/gi, "");
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const variants = new Set();

  while (variants.size < count) {
    const start = Math.max(0, Math.floor(rng() * Math.max(clean.length - 2, 1)));
    const length = clean.length <= 4 ? 2 : clean.length <= 8 ? 3 : 4;
    const mutation = `${alphabet[Math.floor(rng() * alphabet.length)]}${clean.slice(start, start + Math.max(length - 1, 1))}`;
    if (mutation && mutation.length <= 4 && !clean.includes(mutation)) {
      variants.add(mutation);
    } else if (mutation && !clean.includes(mutation)) {
      variants.add(mutation.slice(0, Math.max(length, 2)));
    }
  }
  return [...variants];
}

function generateLetterDistractors(correctPiece, rng, count) {
  const alphabet = "abcdefghijklmnopqrstuvwxyz";
  const letters = new Set();
  while (letters.size < count) {
    const choice = alphabet[Math.floor(rng() * alphabet.length)];
    if (choice !== correctPiece.toLowerCase()) {
      letters.add(choice);
    }
  }
  return [...letters];
}

function buildOrderedTokenBank(coreParts, extraParts, rng) {
  const slots = Array.from({ length: coreParts.length + 1 }, () => []);
  const extras = seededShuffle(
    extraParts.map((text, index) => ({ id: `extra-${index}`, text, correct: false })),
    rng,
  );

  extras.forEach((token) => {
    const slotIndex = Math.floor(rng() * slots.length);
    slots[slotIndex].push(token);
  });

  const bank = [];
  coreParts.forEach((text, index) => {
    bank.push(...slots[index]);
    bank.push({ id: `core-${index}`, text, correct: true });
  });
  bank.push(...slots[slots.length - 1]);
  return bank;
}

function blankExample(example, target) {
  if (!target) {
    return null;
  }
  const regex = new RegExp(buildVariantRegex(target), "i");
  const match = regex.exec(example);
  if (!match) {
    return null;
  }
  const before = example.slice(0, match.index);
  const answer = example.slice(match.index, match.index + match[0].length);
  const after = example.slice(match.index + match[0].length);
  return { before, answer, after };
}

function buildVariantRegex(variant) {
  const tokens = variant.trim().split(/\s+/).map(escapeRegExp);
  if (/^[A-Za-z'.-]+(?:\s+[A-Za-z'.-]+)*$/.test(variant)) {
    return `(?<![A-Za-z])${tokens.join("\\s+")}(?![A-Za-z])`;
  }
  return escapeRegExp(variant);
}

function render() {
  if (state.error) {
    renderError(state.error);
    return;
  }

  if (state.resultView) {
    renderResult();
    return;
  }

  if (state.previewLobby) {
    renderLobby();
    return;
  }

  const mode = state.progress.activeMode;
  if (mode === "practice") {
    renderPractice();
    return;
  }
  if (mode === "capstone") {
    renderCapstone();
    return;
  }
  renderLobby();
}

function renderLoading(message) {
  app.innerHTML = `
    <section class="screen loading-screen">
      <div class="status-panel">
        <h1>Queue Up English</h1>
        <p>${escapeHtml(message)}</p>
      </div>
    </section>
  `;
}

function renderError(error) {
  app.innerHTML = `
    <section class="screen error-screen">
      <div class="status-panel">
        <h1>Queue data is not ready.</h1>
        <p>${escapeHtml(error.message || "Unknown error.")}</p>
        <code>python3 scripts/prepare_course.py "/Users/weiliu/Downloads/四册合并去重_单词词组_加例句.csv" "./data/course.json"</code>
        <div class="status-actions">
          <button class="secondary-btn" data-action="reload">Reload</button>
        </div>
        <p class="footer-note">If you opened the folder directly, the bundled <code>data/course.js</code> fallback should handle it once the data script has been generated.</p>
      </div>
    </section>
  `;
}

function renderLobby() {
  resetQuestionUi();
  const mastered = new Set(state.progress.masteredIds).size;
  const totalItems = state.course.meta.totalItems;
  const isCapstoneUnlocked = state.progress.routeIndex >= state.routeCount;
  const nextRoute = clamp(state.progress.routeIndex, 0, Math.max(state.routeCount - 1, 0));
  const upcomingItems = isCapstoneUnlocked
    ? state.capstonePool.slice(0, 4)
    : getRouteItems(nextRoute).slice(0, 4);
  const routeStartText = state.progress.routeIndex === 0 ? "Start Route 1" : `Resume Route ${state.progress.routeIndex + 1}`;
  const capstoneRemaining = state.progress.capstoneQueue.length + state.progress.capstoneCurrentBatchIds.length;
  const capstoneBatches = Math.ceil(Math.max(state.capstonePool.length, 1) / CAPSTONE_BATCH_SIZE);
  const hasActivePractice = state.progress.activeMode === "practice";
  const hasActiveCapstone = state.progress.activeMode === "capstone";
  const primaryAction = hasActiveCapstone
    ? `<button class="primary-btn" data-action="resume-session">Resume Sentence Gate</button>`
    : hasActivePractice
      ? `<button class="primary-btn" data-action="resume-session">Resume Route ${state.progress.activeRouteIndex + 1}</button>`
      : isCapstoneUnlocked
        ? `<button class="primary-btn" data-action="start-capstone">${
            state.progress.capstoneCurrentBatchIds.length
              ? `Resume Sentence Gate ${state.progress.capstoneCompletedBatches + 1}`
              : capstoneRemaining
                ? `Continue Sentence Gate (${capstoneRemaining} left)`
                : "Start Sentence Gate"
          }</button>`
        : `<button class="primary-btn" data-action="start-route">${routeStartText}</button>`;
  const secondaryAction = hasActiveCapstone
    ? `<button class="secondary-btn" data-action="reseed-capstone">Restart sentence queue</button>`
    : hasActivePractice
      ? `<button class="secondary-btn" data-action="restart-current-route">Restart this route</button>`
      : isCapstoneUnlocked
        ? `<button class="secondary-btn" data-action="reseed-capstone">Shuffle capstone again</button>`
        : `<button class="secondary-btn" data-action="start-route">Open current route</button>`;
  const activeBanner = state.flash
    ? `
      <div class="reward-band">
        <div class="reward-copy">
          <strong>${escapeHtml(state.flash.title)}</strong>
          <span>${escapeHtml(state.flash.body)}</span>
        </div>
        <div class="sticker-cluster">
          <span class="sticker">${state.flash.icon || "⭐"}</span>
        </div>
      </div>
    `
    : "";

  app.innerHTML = `
    <section class="screen hero-screen">
      <div class="hero-shell">
        <div class="hero-copy">
          <div class="brand-row">
            <div>
              <div class="brand-mark">
                <span class="brand-blob"></span>
                Queue Up English
              </div>
              <div class="brand-subtitle">排队闯词场</div>
            </div>
            <button class="mini-btn" data-action="reset-progress">Reset</button>
          </div>
          <div>
            <p class="section-label">Word queue workbook</p>
            <h1 class="hero-title">Step into every gate.<span class="accent-text">Leave with every word.</span></h1>
            <p class="hero-body">A route-based English practice game for iPad. Learn each word or phrase first, then unlock sentence gates in neat twenty-question batches.</p>
          </div>
          <div class="hero-meta">
            <span class="meta-pill"><strong>${mastered}</strong> / ${totalItems} mastered</span>
            <span class="meta-pill"><strong>${state.routeCount}</strong> routes</span>
            <span class="meta-pill"><strong>${state.progress.stickers}</strong> stickers earned</span>
          </div>
          <div class="hero-actions">
            ${primaryAction}
            ${secondaryAction}
          </div>
          ${activeBanner}
        </div>
        <div class="queue-stage">
          <div class="queue-illustration" aria-hidden="true">
            <div class="queue-track">
              <div class="lane-mark"></div>
            </div>
            <div class="gate-house">
              <div class="gate-stamp">Gate</div>
            </div>
            <div class="queue-blob one"><div class="smile"></div></div>
            <div class="queue-blob two"><div class="smile"></div></div>
            <div class="queue-blob three"><div class="smile"></div></div>
            <div class="queue-blob four"><div class="smile"></div></div>
            <div class="queue-blob five"><div class="smile"></div></div>
            <div class="queue-shadow"></div>
          </div>
        </div>
      </div>
      <div class="progress-overview">
        <div class="stats-strip">
          <div>
            <span class="stat-label">Current focus</span>
            <span class="stat-value">${isCapstoneUnlocked ? "Sentence" : `Route ${nextRoute + 1}`}</span>
          </div>
          <div>
            <span class="stat-label">Best streak</span>
            <span class="stat-value">${state.progress.bestStreak}</span>
          </div>
          <div>
            <span class="stat-label">Sentence batches</span>
            <span class="stat-value">${state.progress.capstoneCompletedBatches} / ${capstoneBatches}</span>
          </div>
        </div>
        <div class="route-strip">
          <p class="section-label">${isCapstoneUnlocked ? "Sentence gate status" : "Route map"}</p>
          <h2 class="section-title">${isCapstoneUnlocked ? "Every route is clear. The final lane is open." : "Your next route is already queued."}</h2>
          <div class="route-track">
            ${renderRouteDots()}
          </div>
          <div class="route-legend">
            <span class="legend-dot done">Done</span>
            <span class="legend-dot active">Current</span>
            <span class="legend-dot">Ahead</span>
          </div>
        </div>
        <div class="inline-banner">
          <div>
            <strong>${isCapstoneUnlocked ? "Next up: final sentence batches" : "Next up: route preview"}</strong>
            <span>${upcomingItems.map((item) => item.text).join(" · ") || "The queue is ready."}</span>
          </div>
          ${
            isCapstoneUnlocked
              ? `<button class="secondary-btn" data-action="start-capstone">Open Sentence Gate</button>`
              : `<button class="secondary-btn" data-action="start-route">Open Route ${nextRoute + 1}</button>`
          }
        </div>
      </div>
    </section>
  `;
}

function renderResult() {
  const result = state.resultView;
  if (!result) {
    renderLobby();
    return;
  }

  app.innerHTML = `
    <section class="screen result-screen">
      <div class="result-shell">
        <section class="result-card">
          <div class="brand-row">
            <div>
              <p class="section-label">${escapeHtml(result.eyebrow)}</p>
              <h1 class="result-title">${escapeHtml(result.title)}</h1>
            </div>
            <button class="mini-btn" data-action="go-lobby">Lobby</button>
          </div>
          <p class="result-body">${escapeHtml(result.body)}</p>
          <div class="result-sticker-row">
            <span class="result-sticker">${escapeHtml(result.icon)}</span>
            <div>
              <strong>${escapeHtml(result.ribbonTitle)}</strong>
              <p>${escapeHtml(result.ribbonBody)}</p>
            </div>
          </div>
          <div class="result-stats">
            ${result.stats
              .map(
                (entry) => `
                  <div class="result-stat">
                    <span class="result-stat-label">${escapeHtml(entry.label)}</span>
                    <strong class="result-stat-value">${escapeHtml(entry.value)}</strong>
                  </div>
                `,
              )
              .join("")}
          </div>
          <div class="hero-actions">
            <button class="primary-btn" data-action="${escapeHtml(result.primaryAction)}">${escapeHtml(result.primaryLabel)}</button>
            <button class="secondary-btn" data-action="${escapeHtml(result.secondaryAction)}">${escapeHtml(result.secondaryLabel)}</button>
          </div>
        </section>
        <aside class="result-stage-panel" aria-hidden="true">
          <div class="result-stage-copy">
            <p class="section-label">${escapeHtml(result.stageLabel)}</p>
            <h2>${escapeHtml(result.stageTitle)}</h2>
            <p>${escapeHtml(result.stageBody)}</p>
          </div>
          <div class="result-stage-visual">
            <div class="result-queue-track"></div>
            <div class="queue-blob one"><div class="smile"></div></div>
            <div class="queue-blob two"><div class="smile"></div></div>
            <div class="queue-blob three"><div class="smile"></div></div>
            <div class="result-arch">
              <span>${escapeHtml(result.icon)}</span>
            </div>
            <div class="result-ribbon">
              ${result.badges.map((badge) => `<span class="result-badge">${escapeHtml(badge)}</span>`).join("")}
            </div>
          </div>
        </aside>
      </div>
    </section>
  `;
}

function buildRouteResult(finishedRoute) {
  const mastered = new Set(state.progress.masteredIds).size;
  const unlockedCapstone = state.progress.routeIndex >= state.routeCount;
  const nextLabel = unlockedCapstone ? "Sentence Gate" : `Route ${state.progress.routeIndex + 1}`;

  return {
    eyebrow: unlockedCapstone ? "Workbook complete" : `Route ${finishedRoute} complete`,
    title: unlockedCapstone ? "Every practice route is clear." : `Route ${finishedRoute} is stamped and stored.`,
    body: unlockedCapstone
      ? "You cleared the full route workbook. The final sentence lane is now open, with twenty-question batches waiting behind the gate."
      : "A new sticker landed on the ribbon. The next route is already lined up, so the queue keeps moving.",
    icon: unlockedCapstone ? "🏁" : "⭐",
    ribbonTitle: unlockedCapstone ? "Sentence Gate unlocked" : "Sticker added",
    ribbonBody: unlockedCapstone
      ? "From here on, the game shifts from hint matching to sentence fill challenges."
      : "Short wins stay visible. That makes progress feel concrete for younger players.",
    stageLabel: unlockedCapstone ? "Final lane" : "Queue ribbon",
    stageTitle: unlockedCapstone ? "The sentence arch is lit." : "The queue took one more happy step.",
    stageBody: unlockedCapstone
      ? "Use the examples from the course and choose the best word or phrase in each sentence."
      : "Keep the pace light: one route, one reward, then straight into the next set.",
    primaryLabel: unlockedCapstone ? "Open Sentence Gate" : `Start ${nextLabel}`,
    primaryAction: unlockedCapstone ? "start-capstone" : "start-route",
    secondaryLabel: "Back to Lobby",
    secondaryAction: "go-lobby",
    badges: unlockedCapstone ? ["All routes", "20-question batches"] : [`Sticker ${state.progress.stickers}`, nextLabel],
    stats: [
      { label: "Mastered", value: `${mastered} / ${state.course.meta.totalItems}` },
      { label: "Stickers", value: String(state.progress.stickers) },
      { label: "Next", value: nextLabel },
    ],
  };
}

function buildCapstoneResult(remaining) {
  const clearedBatches = state.progress.capstoneCompletedBatches;
  const finishedAll = remaining === 0;

  return {
    eyebrow: finishedAll ? "Sentence gate complete" : `Sentence Gate ${clearedBatches} complete`,
    title: finishedAll ? "Every sentence batch is done." : `Batch ${clearedBatches} has been stamped.`,
    body: finishedAll
      ? "You finished every currently eligible sentence question. Shuffle the lane and replay any time."
      : `${remaining} sentence questions are still waiting in line. The next batch is ready whenever you want it.`,
    icon: finishedAll ? "🎊" : "🎉",
    ribbonTitle: finishedAll ? "Full capstone clear" : "Batch clear",
    ribbonBody: finishedAll
      ? "This run covered the complete sentence pool that passed the course filters."
      : "The capstone stays light by serving only twenty questions at a time.",
    stageLabel: finishedAll ? "Replay lane" : "Next batch",
    stageTitle: finishedAll ? "The whole queue is celebrating." : "Another sentence arch is already loading.",
    stageBody: finishedAll
      ? "Reshuffle to replay the sentence lane in a fresh order without touching route progress."
      : "Keep the rhythm going with another batch, or pause and come back from the lobby.",
    primaryLabel: finishedAll ? "Shuffle Sentence Gate" : `Open Batch ${clearedBatches + 1}`,
    primaryAction: finishedAll ? "reseed-capstone" : "start-capstone",
    secondaryLabel: "Back to Lobby",
    secondaryAction: "go-lobby",
    badges: finishedAll ? ["All batches", "Replay ready"] : [`Batch ${clearedBatches}`, `${remaining} left`],
    stats: [
      { label: "Batches", value: String(clearedBatches) },
      { label: "Remaining", value: String(remaining) },
      { label: "Best streak", value: String(state.progress.bestStreak) },
    ],
  };
}

function renderRouteDots() {
  if (!state.routeCount) {
    return "";
  }

  const dots = [];
  const current = clamp(state.progress.routeIndex, 0, Math.max(state.routeCount - 1, 0));
  const visibleCount = Math.min(9, state.routeCount);
  const start = Math.max(0, Math.min(current - 3, state.routeCount - visibleCount));
  const end = Math.min(state.routeCount, start + visibleCount);

  if (start > 0) {
    dots.push(`<span class="route-dot ${state.progress.routeIndex > 0 ? "done" : current === 0 ? "active" : ""}">1</span>`);
    if (start > 1) {
      dots.push(`<span class="route-dot">…</span>`);
    }
  }

  for (let index = start; index < end; index += 1) {
    const classNames = ["route-dot"];
    if (index < state.progress.routeIndex) {
      classNames.push("done");
    } else if (index === current && state.progress.routeIndex < state.routeCount) {
      classNames.push("active");
    }
    dots.push(`<span class="${classNames.join(" ")}">${index + 1}</span>`);
  }

  if (end < state.routeCount) {
    if (end < state.routeCount - 1) {
      dots.push(`<span class="route-dot">…</span>`);
    }
    const lastIndex = state.routeCount - 1;
    const classNames = ["route-dot"];
    if (lastIndex < state.progress.routeIndex) {
      classNames.push("done");
    } else if (lastIndex === current && state.progress.routeIndex < state.routeCount) {
      classNames.push("active");
    }
    dots.push(`<span class="${classNames.join(" ")}">${state.routeCount}</span>`);
  }

  return dots.join("");
}

function renderPractice() {
  const question = getCurrentPracticeQuestion();
  if (!question) {
    state.progress.activeMode = "lobby";
    saveProgress();
    renderLobby();
    return;
  }

  primeQuestionUi(question.key);
  const routeItems = getRouteItems(state.progress.activeRouteIndex);
  const progressPosition = state.progress.activeQuestionIndex + 1;
  const copy = GATE_COPY[question.type];

  app.innerHTML = `
    <section class="screen practice-screen">
      <div class="practice-header">
        <div class="header-side">
          <button class="mini-btn" data-action="go-lobby">Lobby</button>
          <span class="mini-chip">Route <strong>${state.progress.activeRouteIndex + 1}</strong> / ${state.routeCount}</span>
          <span class="mini-chip">Step <strong>${progressPosition}</strong> / ${routeItems.length}</span>
        </div>
        <div class="header-side">
          <span class="mini-chip">Streak <strong>${state.progress.currentStreak}</strong></span>
        </div>
      </div>
      <div class="workspace workspace--solo">
        <section class="gate-main">
          <div>
            <div class="gate-topline">
              <span class="gate-label"><span class="dot"></span>${copy.label}</span>
              <div class="chip-row">
                <span class="chip">${question.item.itemType === "phrase" ? "词组" : "单词"}</span>
                <span class="chip">${difficultyLabel(question.item.difficulty)}</span>
              </div>
            </div>
            <p class="gate-kicker">${copy.kicker}</p>
            <h1 class="hint-title">${escapeHtml(question.item.cnHint)}</h1>
            <p class="hint-subtitle">${copy.prompt}</p>
            <div class="question-shell">
              ${renderQuestionBody(question)}
              ${renderFeedback(question)}
            </div>
          </div>
        </section>
      </div>
    </section>
  `;
}

function renderCapstone() {
  const question = getCurrentCapstoneQuestion();
  if (!question) {
    state.progress.activeMode = "lobby";
    state.progress.capstoneCurrentBatchIds = [];
    state.progress.capstoneQuestionIndex = 0;
    saveProgress();
    renderLobby();
    return;
  }

  primeQuestionUi(question.key);
  const copy = GATE_COPY.sentence;
  const batchSize = state.progress.capstoneCurrentBatchIds.length;
  const batchNumber = state.progress.capstoneCompletedBatches + 1;

  app.innerHTML = `
    <section class="screen gate-screen">
      <div class="practice-header">
        <div class="header-side">
          <button class="mini-btn" data-action="go-lobby">Lobby</button>
          <span class="mini-chip">Sentence Gate <strong>${batchNumber}</strong></span>
          <span class="mini-chip">Question <strong>${state.progress.capstoneQuestionIndex + 1}</strong> / ${batchSize}</span>
        </div>
        <div class="header-side">
          <span class="mini-chip">Streak <strong>${state.progress.currentStreak}</strong></span>
        </div>
      </div>
      <div class="workspace workspace--solo">
        <section class="gate-main">
          <div>
            <div class="gate-topline">
              <span class="gate-label"><span class="dot"></span>${copy.label}</span>
              <div class="chip-row">
                <span class="chip">${question.item.itemType === "phrase" ? "词组" : "单词"}</span>
                <span class="chip">${difficultyLabel(question.item.difficulty)}</span>
              </div>
            </div>
            <p class="gate-kicker">${copy.kicker}</p>
            <h1 class="hint-title">${escapeHtml(question.item.cnHint)}</h1>
            <p class="hint-subtitle">${copy.prompt}</p>
            <div class="question-shell">
              ${renderQuestionBody(question)}
              ${renderFeedback(question)}
            </div>
          </div>
        </section>
      </div>
    </section>
  `;
}

function renderQuestionBody(question) {
  if (question.type === "build") {
    return renderBuildBody(question);
  }
  if (question.type === "fix") {
    return renderFixBody(question);
  }
  if (question.type === "sentence") {
    return renderSentenceBody(question);
  }
  return renderPickBody(question);
}

function renderPickBody(question) {
  return `
    <div class="chip-row">
      <span class="chip">${question.item.text.length} chars</span>
      <span class="chip">${question.item.category}</span>
    </div>
    <div class="option-grid">
      ${question.options
        .map((option) => {
          const classNames = ["option-btn"];
          if (state.ui.feedback && state.ui.feedback.optionId === option.id && state.ui.feedback.type === "correct") {
            classNames.push("is-correct");
          }
          if (state.ui.feedback && state.ui.feedback.optionId === option.id && state.ui.feedback.type === "wrong") {
            classNames.push("is-wrong");
          }
          return `
            <button class="${classNames.join(" ")}" data-action="choose-option" data-value="${escapeHtml(option.id)}">
              <strong>${escapeHtml(option.label)}</strong>
            </button>
          `;
        })
        .join("")}
    </div>
  `;
}

function renderBuildBody(question) {
  const selectedTokens = question.tokens.filter((token) => state.ui.selection.includes(token.id));
  const assembled = selectedTokens.map((token) => token.text).join(question.separator);
  return `
    <div class="build-stage">
      <div class="chip-row">
        <span class="chip">${question.hint}</span>
        <span class="chip">${question.item.itemType === "phrase" ? "Keep the order clean" : "Listen for the chunk rhythm"}</span>
      </div>
      <div class="assembled-answer ${assembled ? "" : "is-empty"}">
        ${assembled ? selectedTokens.map((token) => `<span class="assembled-token">${escapeHtml(token.text)}</span>`).join("") : "Tap the pieces in order."}
      </div>
      <div class="tile-bank">
        ${question.tokens
          .map((token) => `
            <button
              class="tile-btn ${state.ui.selection.includes(token.id) ? "is-used" : ""}"
              data-action="build-pick"
              data-value="${escapeHtml(token.id)}"
            >
              ${escapeHtml(token.text)}
            </button>
          `)
          .join("")}
      </div>
      <div class="chip-actions">
        <button class="chip-btn" data-action="build-check">Check</button>
        <button class="chip-btn" data-action="build-undo">Undo</button>
        <button class="chip-btn" data-action="build-clear">Clear</button>
      </div>
    </div>
  `;
}

function renderFixBody(question) {
  return `
    <div class="fix-stage">
      <div class="chip-row">
        <span class="chip">${escapeHtml(question.helper)}</span>
      </div>
      <div class="mutated-word">
        ${question.display
          .map((piece) => `
            <span class="fix-tile">${escapeHtml(piece)}</span>
          `)
          .join("")}
      </div>
      <div class="tile-bank">
        ${question.choices
          .map((choice) => `
            <button class="tile-btn" data-action="choose-fix" data-value="${escapeHtml(choice)}">${escapeHtml(choice)}</button>
          `)
          .join("")}
      </div>
    </div>
  `;
}

function renderSentenceBody(question) {
  const revealAnswer = Boolean(state.ui.pendingAdvance && state.ui.feedback?.type === "correct");
  return `
    <div class="sentence-stage">
      <div class="chip-row">
        <span class="chip">Sentence fill</span>
        <span class="chip">${question.item.itemType === "phrase" ? "Spot the whole phrase" : "Spot the single word"}</span>
      </div>
      <div class="sentence-row">
        <span>${escapeHtml(question.sentence.before)}</span>
        ${
          revealAnswer
            ? `<span class="sentence-answer">${escapeHtml(question.sentence.answer)}</span>`
            : `<span class="sentence-blank">_____</span>`
        }
        <span>${escapeHtml(question.sentence.after)}</span>
      </div>
      <div class="option-grid">
        ${question.options
          .map((option) => {
            const classNames = ["option-btn"];
            if (state.ui.feedback && state.ui.feedback.optionId === option.id && state.ui.feedback.type === "correct") {
              classNames.push("is-correct");
            }
            if (state.ui.feedback && state.ui.feedback.optionId === option.id && state.ui.feedback.type === "wrong") {
              classNames.push("is-wrong");
          }
          return `
              <button class="${classNames.join(" ")}" data-action="choose-option" data-value="${escapeHtml(option.id)}">
                <strong>${escapeHtml(option.label)}</strong>
              </button>
            `;
          })
          .join("")}
      </div>
    </div>
  `;
}

function renderFeedback(question) {
  if (!state.ui.feedback) {
    return "";
  }

  const success = state.ui.feedback.type === "correct";
  return `
    <div class="feedback-box ${success ? "success" : "error"}">
      <div>
        <strong>${success ? "Gate open." : "Try one more time."}</strong>
        <p>${escapeHtml(state.ui.feedback.message)}</p>
      </div>
      ${
        success
          ? `<button class="primary-btn" data-action="advance">Next</button>`
          : `<button class="secondary-btn" data-action="clear-feedback">Keep trying</button>`
      }
    </div>
  `;
}

function handleClick(event) {
  const target = event.target.closest("[data-action]");
  if (!target) {
    return;
  }

  const action = target.dataset.action;
  const value = target.dataset.value;

  if (action === "reload") {
    window.location.reload();
    return;
  }
  if (action === "go-lobby") {
    if (state.resultView) {
      state.resultView = null;
      state.previewLobby = false;
    } else {
      state.previewLobby = true;
    }
    render();
    return;
  }
  if (action === "resume-session") {
    state.resultView = null;
    state.previewLobby = false;
    render();
    return;
  }
  if (action === "start-route") {
    state.resultView = null;
    state.previewLobby = false;
    startRoute(state.progress.routeIndex);
    return;
  }
  if (action === "restart-current-route") {
    state.resultView = null;
    state.previewLobby = false;
    startRoute(state.progress.activeRouteIndex ?? state.progress.routeIndex);
    return;
  }
  if (action === "start-capstone") {
    state.resultView = null;
    state.previewLobby = false;
    startCapstone();
    return;
  }
  if (action === "reseed-capstone") {
    state.resultView = null;
    state.previewLobby = false;
    state.progress.capstoneQueue = [];
    state.progress.capstoneCurrentBatchIds = [];
    state.progress.capstoneQuestionIndex = 0;
    state.progress.activeMode = "lobby";
    saveProgress();
    state.flash = {
      title: "Sentence gate reshuffled",
      body: "A fresh batch order is ready for the final lane.",
      icon: "🎟️",
    };
    render();
    return;
  }
  if (action === "reset-progress") {
    if (!window.confirm("Reset all route and sentence progress?")) {
      return;
    }
    state.progress = defaultProgress();
    state.resultView = null;
    state.previewLobby = false;
    state.flash = {
      title: "Fresh queue ready",
      body: "All progress was cleared. The first route is open again.",
      icon: "🌀",
    };
    saveProgress();
    render();
    return;
  }
  if (action === "clear-feedback") {
    state.ui.feedback = null;
    render();
    return;
  }
  if (action === "choose-option") {
    handleChoice(value);
    return;
  }
  if (action === "build-pick") {
    if (!state.ui.selection.includes(value)) {
      state.ui.selection = [...state.ui.selection, value];
      render();
    }
    return;
  }
  if (action === "build-undo") {
    state.ui.selection = state.ui.selection.slice(0, -1);
    render();
    return;
  }
  if (action === "build-clear") {
    state.ui.selection = [];
    render();
    return;
  }
  if (action === "build-check") {
    handleBuildCheck();
    return;
  }
  if (action === "choose-fix") {
    handleFixChoice(value);
    return;
  }
  if (action === "advance") {
    advanceQuestion();
  }
}

function handleChoice(optionId) {
  const question = state.progress.activeMode === "capstone" ? getCurrentCapstoneQuestion() : getCurrentPracticeQuestion();
  if (!question || state.ui.pendingAdvance) {
    return;
  }

  if (optionId === question.correctId) {
    playSound("correct");
    state.ui.feedback = {
      type: "correct",
      optionId,
      message: `${question.item.text} fits the gate.`,
    };
    state.ui.pendingAdvance = true;
  } else {
    playSound("wrong");
    state.progress.currentStreak = 0;
    saveProgress();
    state.ui.feedback = {
      type: "wrong",
      optionId,
      message: "That one does not match the hint. Use the Chinese clue and item type together.",
    };
  }
  render();
}

function handleBuildCheck() {
  const question = getCurrentPracticeQuestion();
  if (!question || question.type !== "build" || state.ui.pendingAdvance) {
    return;
  }

  const correct = state.ui.selection.join("|") === question.correctTokenIds.join("|");
  if (correct) {
    playSound("correct");
    state.ui.feedback = {
      type: "correct",
      message: `${question.item.text} is fully built.`,
    };
    state.ui.pendingAdvance = true;
  } else {
    playSound("wrong");
    state.progress.currentStreak = 0;
    saveProgress();
    state.ui.feedback = {
      type: "wrong",
      message: "The order is still off. Clear it and rebuild the gate.",
    };
  }
  render();
}

function handleFixChoice(choice) {
  const question = getCurrentPracticeQuestion();
  if (!question || question.type !== "fix" || state.ui.pendingAdvance) {
    return;
  }

  if (choice === question.correctPiece) {
    playSound("correct");
    state.ui.feedback = {
      type: "correct",
      message: `${question.item.text} is repaired.`,
    };
    state.ui.pendingAdvance = true;
  } else {
    playSound("wrong");
    state.progress.currentStreak = 0;
    saveProgress();
    state.ui.feedback = {
      type: "wrong",
      message: "That piece does not repair the word yet.",
    };
  }
  render();
}

function advanceQuestion() {
  const question = state.progress.activeMode === "capstone" ? getCurrentCapstoneQuestion() : getCurrentPracticeQuestion();
  if (!question || !state.ui.pendingAdvance) {
    return;
  }

  state.progress.currentStreak += 1;
  state.progress.bestStreak = Math.max(state.progress.bestStreak, state.progress.currentStreak);

  if (state.progress.activeMode === "practice") {
    markMastered(question.item.id);
    const routeItems = getRouteItems(state.progress.activeRouteIndex);
    state.progress.activeQuestionIndex += 1;
    if (state.progress.activeQuestionIndex >= routeItems.length) {
      const finishedRoute = state.progress.activeRouteIndex + 1;
      state.progress.routeIndex = Math.max(state.progress.routeIndex, finishedRoute);
      state.progress.activeMode = "lobby";
      state.progress.activeRouteIndex = null;
      state.progress.activeQuestionIndex = 0;
      state.progress.stickers += 1;
      state.flash = null;
      state.resultView = buildRouteResult(finishedRoute);
      playSound("clear");
    }
  } else {
    state.progress.capstoneQuestionIndex += 1;
    if (state.progress.capstoneQuestionIndex >= state.progress.capstoneCurrentBatchIds.length) {
      const completedBatch = state.progress.capstoneCurrentBatchIds;
      const remaining = state.progress.capstoneQueue.filter((id) => !completedBatch.includes(id));
      state.progress.capstoneQueue = remaining;
      state.progress.capstoneCurrentBatchIds = [];
      state.progress.capstoneQuestionIndex = 0;
      state.progress.capstoneCompletedBatches += 1;
      state.progress.activeMode = "lobby";
      state.flash = null;
      state.resultView = buildCapstoneResult(remaining.length);
      playSound("clear");
    }
  }

  resetQuestionUi();
  saveProgress();
  render();
}

function markMastered(itemId) {
  if (!state.progress.practicedIds.includes(itemId)) {
    state.progress.practicedIds.push(itemId);
  }
  if (!state.progress.masteredIds.includes(itemId)) {
    state.progress.masteredIds.push(itemId);
  }
}

function startRoute(routeIndex) {
  if (routeIndex >= state.routeCount) {
    startCapstone();
    return;
  }

  state.previewLobby = false;
  state.resultView = null;
  state.progress.activeMode = "practice";
  state.progress.activeRouteIndex = routeIndex;
  state.progress.activeQuestionIndex = 0;
  state.progress.currentStreak = 0;
  state.flash = null;
  resetQuestionUi();
  saveProgress();
  render();
}

function startCapstone() {
  if (!state.capstonePool.length) {
    state.flash = {
      title: "Sentence gate is not ready yet",
      body: "No eligible sentence questions were found in the current course data.",
      icon: "⚠️",
    };
    render();
    return;
  }

  state.previewLobby = false;
  state.resultView = null;
  if (!state.progress.capstoneQueue.length && !state.progress.capstoneCurrentBatchIds.length) {
    const rng = seededRng("capstone-seed");
    state.progress.capstoneQueue = seededShuffle(
      state.capstonePool.map((item) => item.id),
      rng,
    );
  }

  if (!state.progress.capstoneCurrentBatchIds.length) {
    state.progress.capstoneCurrentBatchIds = state.progress.capstoneQueue.slice(0, CAPSTONE_BATCH_SIZE);
    state.progress.capstoneQuestionIndex = 0;
    state.progress.currentStreak = 0;
  }

  state.progress.activeMode = "capstone";
  state.flash = null;
  resetQuestionUi();
  saveProgress();
  render();
}

function primeQuestionUi(questionKey) {
  if (state.ui.questionKey !== questionKey) {
    state.ui.questionKey = questionKey;
    state.ui.selection = [];
    state.ui.feedback = null;
    state.ui.pendingAdvance = false;
  }
}

function resetQuestionUi() {
  state.ui.questionKey = null;
  state.ui.selection = [];
  state.ui.feedback = null;
  state.ui.pendingAdvance = false;
}

function normalizeText(value) {
  return (value || "").replace(/\s+/g, " ").trim();
}

function difficultyLabel(value) {
  return value === "hard" ? "Hard" : value === "medium" ? "Warm" : "Easy";
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hashString(input) {
  let hash = 1779033703 ^ input.length;
  for (let index = 0; index < input.length; index += 1) {
    hash = Math.imul(hash ^ input.charCodeAt(index), 3432918353);
    hash = (hash << 13) | (hash >>> 19);
  }
  return () => {
    hash = Math.imul(hash ^ (hash >>> 16), 2246822507);
    hash = Math.imul(hash ^ (hash >>> 13), 3266489909);
    return (hash ^= hash >>> 16) >>> 0;
  };
}

function seededRng(seed) {
  const seedFactory = hashString(seed);
  let value = seedFactory();
  return () => {
    value |= 0;
    value = (value + 0x6d2b79f5) | 0;
    let temp = Math.imul(value ^ (value >>> 15), 1 | value);
    temp = (temp + Math.imul(temp ^ (temp >>> 7), 61 | temp)) ^ temp;
    return ((temp ^ (temp >>> 14)) >>> 0) / 4294967296;
  };
}

function seededShuffle(items, rng) {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(rng() * (index + 1));
    [copy[index], copy[swapIndex]] = [copy[swapIndex], copy[index]];
  }
  return copy;
}

function getActiveQuestionSnapshot() {
  const mode = state.progress?.activeMode;
  const question = mode === "capstone" ? getCurrentCapstoneQuestion() : mode === "practice" ? getCurrentPracticeQuestion() : null;
  if (!question) {
    return null;
  }

  const snapshot = {
    type: question.type,
    hint: question.item.cnHint,
    feedback: state.ui.feedback?.type || null,
  };

  if (question.type === "build") {
    snapshot.options = question.tokens.map((token) => token.text);
    snapshot.selection = state.ui.selection
      .map((tokenId) => question.tokens.find((token) => token.id === tokenId)?.text)
      .filter(Boolean);
  } else if (question.type === "fix") {
    snapshot.options = question.choices;
  } else {
    snapshot.options = question.options.map((option) => option.label);
  }

  if (question.type === "sentence") {
    snapshot.sentence = `${question.sentence.before} _____ ${question.sentence.after}`.replace(/\s+/g, " ").trim();
  }

  if (shouldExposeSolutions()) {
    snapshot.answer = question.item.text;
    if (question.type === "build") {
      snapshot.correctSequence = question.correctTokenIds
        .map((tokenId) => question.tokens.find((token) => token.id === tokenId)?.text)
        .filter(Boolean);
    }
    if (question.type === "fix") {
      snapshot.correctChoice = question.correctPiece;
    }
  }

  return snapshot;
}

function renderGameToText() {
  return JSON.stringify({
    screen: state.error ? "error" : state.resultView ? "result" : state.previewLobby ? "lobby-preview" : state.progress?.activeMode || "loading",
    routeIndex: state.progress?.routeIndex ?? 0,
    routeCount: state.routeCount,
    activeRouteIndex: state.progress?.activeRouteIndex,
    activeQuestionIndex: state.progress?.activeQuestionIndex ?? 0,
    streak: state.progress?.currentStreak ?? 0,
    bestStreak: state.progress?.bestStreak ?? 0,
    stickers: state.progress?.stickers ?? 0,
    flash: state.flash ? { title: state.flash.title, body: state.flash.body } : null,
    result: state.resultView
      ? {
          title: state.resultView.title,
          primaryLabel: state.resultView.primaryLabel,
          secondaryLabel: state.resultView.secondaryLabel,
        }
      : null,
    question: getActiveQuestionSnapshot(),
  });
}

function shouldExposeSolutions() {
  if (typeof window === "undefined") {
    return false;
  }
  const { hostname, search } = window.location;
  return hostname === "127.0.0.1" || hostname === "localhost" || search.includes("debug=1");
}

function getAudioContext() {
  if (typeof window === "undefined") {
    return null;
  }

  const AudioCtor = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtor) {
    return null;
  }

  if (!state.audio.context) {
    state.audio.context = new AudioCtor();
  }
  return state.audio.context;
}

function playTone(context, startAt, frequency, duration, options = {}) {
  const oscillator = context.createOscillator();
  const gainNode = context.createGain();

  oscillator.type = options.type || "sine";
  oscillator.frequency.setValueAtTime(frequency, startAt);
  if (options.endFrequency) {
    oscillator.frequency.exponentialRampToValueAtTime(options.endFrequency, startAt + duration);
  }

  const peak = options.gain ?? 0.09;
  gainNode.gain.setValueAtTime(0.0001, startAt);
  gainNode.gain.exponentialRampToValueAtTime(peak, startAt + 0.02);
  gainNode.gain.exponentialRampToValueAtTime(0.0001, startAt + duration);

  oscillator.connect(gainNode);
  gainNode.connect(context.destination);
  oscillator.start(startAt);
  oscillator.stop(startAt + duration + 0.02);
}

function playSound(type) {
  const context = getAudioContext();
  if (!context) {
    return;
  }

  const run = () => {
    const start = context.currentTime + 0.01;
    if (type === "wrong") {
      playTone(context, start, 320, 0.11, { type: "square", endFrequency: 220, gain: 0.08 });
      playTone(context, start + 0.12, 210, 0.09, { type: "triangle", endFrequency: 170, gain: 0.05 });
      return;
    }

    if (type === "clear") {
      playTone(context, start, 392, 0.12, { type: "triangle", gain: 0.09 });
      playTone(context, start + 0.12, 523.25, 0.14, { type: "triangle", gain: 0.09 });
      playTone(context, start + 0.26, 659.25, 0.22, { type: "triangle", gain: 0.1 });
      return;
    }

    playTone(context, start, 523.25, 0.09, { type: "sine", gain: 0.08 });
    playTone(context, start + 0.09, 659.25, 0.12, { type: "sine", gain: 0.08 });
  };

  if (context.state === "suspended") {
    context.resume().then(run).catch(() => {});
    return;
  }

  run();
}

if (typeof window !== "undefined") {
  window.render_game_to_text = renderGameToText;
  window.advanceTime = (ms = 0) => {
    void ms;
    render();
    return renderGameToText();
  };
}
