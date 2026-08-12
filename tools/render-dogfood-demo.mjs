#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WIDTH = 640;
const HEIGHT = 360;
const FRAME_DELAY_CS = 60;
const FRAMES_PER_PHASE = 5;

const COLORS = {
  background: 0,
  panel: 1,
  border: 2,
  text: 3,
  muted: 4,
  cyan: 5,
  green: 6,
  amber: 7,
  red: 8,
  purple: 9,
  navy: 10,
  soft: 11,
};

const PALETTE = [
  [7, 17, 31],
  [13, 27, 42],
  [35, 52, 77],
  [242, 246, 250],
  [147, 164, 184],
  [56, 189, 248],
  [52, 211, 153],
  [251, 191, 36],
  [251, 113, 133],
  [167, 139, 250],
  [5, 12, 24],
  [57, 75, 99],
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
  [0, 0, 0],
];

const FONT = {
  " ": ["00000", "00000", "00000", "00000", "00000", "00000", "00000"],
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01111"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["11111", "00100", "00100", "00100", "00100", "00100", "11111"],
  J: ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "10001", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "10101", "01010"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00010", "00100", "01000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "10000", "11110", "00001", "00001", "11110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  ":": ["00000", "00100", "00100", "00000", "00100", "00100", "00000"],
  ".": ["00000", "00000", "00000", "00000", "00000", "00110", "00110"],
  ",": ["00000", "00000", "00000", "00000", "00110", "00110", "00100"],
  "-": ["00000", "00000", "00000", "11111", "00000", "00000", "00000"],
  "+": ["00000", "00100", "00100", "11111", "00100", "00100", "00000"],
  "/": ["00001", "00010", "00010", "00100", "01000", "01000", "10000"],
  "=": ["00000", "00000", "11111", "00000", "11111", "00000", "00000"],
  "!": ["00100", "00100", "00100", "00100", "00100", "00000", "00100"],
  ">": ["10000", "01000", "00100", "00010", "00100", "01000", "10000"],
  "<": ["00001", "00010", "00100", "01000", "00100", "00010", "00001"],
  "[": ["01110", "01000", "01000", "01000", "01000", "01000", "01110"],
  "]": ["01110", "00010", "00010", "00010", "00010", "00010", "01110"],
  "?": ["01110", "10001", "00001", "00010", "00100", "00000", "00100"],
};

const PHASES = [
  { short: "TASK", color: COLORS.purple, second: 0 },
  { short: "PACK", color: COLORS.cyan, second: 18 },
  { short: "VERIFY", color: COLORS.green, second: 36 },
  { short: "STALE", color: COLORS.red, second: 54 },
  { short: "NEXT", color: COLORS.amber, second: 75 },
];

function frameBuffer() {
  return new Uint8Array(WIDTH * HEIGHT).fill(COLORS.background);
}

function setPixel(frame, x, y, color) {
  if (x >= 0 && x < WIDTH && y >= 0 && y < HEIGHT) {
    frame[y * WIDTH + x] = color;
  }
}

function fillRect(frame, x, y, width, height, color) {
  const startX = Math.max(0, x);
  const endX = Math.min(WIDTH, x + width);
  const startY = Math.max(0, y);
  const endY = Math.min(HEIGHT, y + height);
  for (let row = startY; row < endY; row += 1) {
    frame.fill(color, row * WIDTH + startX, row * WIDTH + endX);
  }
}

function strokeRect(frame, x, y, width, height, color, thickness = 1) {
  fillRect(frame, x, y, width, thickness, color);
  fillRect(frame, x, y + height - thickness, width, thickness, color);
  fillRect(frame, x, y, thickness, height, color);
  fillRect(frame, x + width - thickness, y, thickness, height, color);
}

function drawText(frame, text, x, y, color = COLORS.text, scale = 1) {
  let cursor = x;
  for (const rawCharacter of String(text).toUpperCase()) {
    const glyph = FONT[rawCharacter] ?? FONT["?"];
    for (let row = 0; row < 7; row += 1) {
      for (let column = 0; column < 5; column += 1) {
        if (glyph[row][column] === "1") {
          fillRect(frame, cursor + column * scale, y + row * scale, scale, scale, color);
        }
      }
    }
    cursor += 6 * scale;
  }
  return cursor;
}

function textWidth(text, scale = 1) {
  return Math.max(0, String(text).length * 6 * scale - scale);
}

function centerText(frame, text, centerX, y, color, scale = 1) {
  drawText(frame, text, Math.round(centerX - textWidth(text, scale) / 2), y, color, scale);
}

function drawCheck(frame, x, y, color) {
  fillRect(frame, x, y + 4, 3, 3, color);
  fillRect(frame, x + 3, y + 7, 3, 3, color);
  fillRect(frame, x + 6, y + 4, 3, 3, color);
  fillRect(frame, x + 9, y + 1, 3, 3, color);
}

function drawCross(frame, x, y, color) {
  for (let index = 0; index < 10; index += 1) {
    fillRect(frame, x + index, y + index, 2, 2, color);
    fillRect(frame, x + 9 - index, y + index, 2, 2, color);
  }
}

function drawArrow(frame, x, y, width, color) {
  fillRect(frame, x, y + 4, width - 8, 3, color);
  for (let index = 0; index < 5; index += 1) {
    fillRect(frame, x + width - 10 + index * 2, y + index, 3, 3, color);
    fillRect(frame, x + width - 10 + index * 2, y + 8 - index, 3, 3, color);
  }
}

function drawBackground(frame) {
  for (let y = 8; y < HEIGHT; y += 24) {
    for (let x = 8; x < WIDTH; x += 24) {
      setPixel(frame, x, y, COLORS.border);
    }
  }
  fillRect(frame, 0, 0, WIDTH, 4, COLORS.cyan);
}

function drawHeader(frame, phase, subframe) {
  drawText(frame, "CONTEXT RELAY", 24, 20, COLORS.text, 3);
  drawText(frame, "EVIDENCE-BACKED AI WORK HANDOFF", 26, 50, COLORS.muted, 1);
  const storySecond = Math.min(
    75,
    Math.round(PHASES[phase].second + (phase < PHASES.length - 1 ? subframe * 3.6 : 0)),
  );
  drawText(
    frame,
    `STORY ${String(storySecond).padStart(2, "0")}S / 75S  -  LOOP 15S`,
    414,
    50,
    COLORS.muted,
    1,
  );

  const chipWidth = 104;
  const gap = 14;
  const startX = 28;
  for (let index = 0; index < PHASES.length; index += 1) {
    const x = startX + index * (chipWidth + gap);
    const active = index === phase;
    const complete = index < phase;
    const color = active || complete ? PHASES[index].color : COLORS.border;
    fillRect(frame, x, 76, chipWidth, 24, active ? COLORS.soft : COLORS.panel);
    strokeRect(frame, x, 76, chipWidth, 24, color, active ? 2 : 1);
    centerText(frame, `${index + 1} ${PHASES[index].short}`, x + chipWidth / 2, 85, active ? COLORS.text : complete ? color : COLORS.muted, 1);
  }

  fillRect(frame, 28, 111, 584, 3, COLORS.border);
  const phaseProgress = (phase + (subframe + 1) / FRAMES_PER_PHASE) / PHASES.length;
  fillRect(frame, 28, 111, Math.round(584 * phaseProgress), 3, PHASES[phase].color);
}

function drawPanel(frame, accent) {
  fillRect(frame, 24, 128, 592, 180, COLORS.navy);
  strokeRect(frame, 24, 128, 592, 180, COLORS.border, 2);
  fillRect(frame, 24, 128, 6, 180, accent);
}

function drawListItem(frame, text, x, y, color, complete = true) {
  if (complete) drawCheck(frame, x, y, color);
  else strokeRect(frame, x, y + 1, 11, 11, COLORS.border);
  drawText(frame, text, x + 20, y + 1, COLORS.text, 2);
}

function renderLongTask(frame, subframe) {
  drawPanel(frame, COLORS.purple);
  drawText(frame, "1  LONG TASK", 48, 146, COLORS.purple, 2);
  drawText(frame, "WORK SPANS MANY TURNS", 48, 174, COLORS.text, 2);
  const items = ["FILES CHANGE", "COMMANDS RUN", "DECISIONS ACCUMULATE"];
  items.forEach((item, index) => {
    const color = index <= Math.min(2, subframe) ? COLORS.purple : COLORS.border;
    fillRect(frame, 52, 206 + index * 23, 12, 12, color);
    drawText(frame, item, 76, 205 + index * 23, index <= subframe ? COLORS.text : COLORS.muted, 2);
  });
  fillRect(frame, 420, 172, 156, 98, COLORS.panel);
  strokeRect(frame, 420, 172, 156, 98, COLORS.border);
  ["EDIT", "TEST", "DECIDE"].forEach((label, index) => {
    const y = 186 + index * 25;
    drawText(frame, label, 438, y, index <= subframe ? COLORS.text : COLORS.muted, 2);
    fillRect(frame, 528, y + 1, 28, 10, index <= subframe ? COLORS.purple : COLORS.border);
  });
}

function renderHandoff(frame, subframe) {
  drawPanel(frame, COLORS.cyan);
  drawText(frame, "2  EVIDENCE-BACKED HANDOFF", 48, 146, COLORS.cyan, 2);
  drawText(frame, "THE PACK RECORDS WHAT CAN BE CHECKED", 48, 174, COLORS.text, 2);
  const items = [
    "GOAL AND SCOPE",
    "CHANGED FILES",
    "COMMANDS AND EXIT CODES",
    "BLOCKERS AND NEXT ACTION",
  ];
  items.forEach((item, index) => {
    drawListItem(frame, item, 52, 204 + index * 22, index <= subframe ? COLORS.cyan : COLORS.border, index <= subframe);
  });
  fillRect(frame, 468, 198, 108, 72, COLORS.panel);
  strokeRect(frame, 468, 198, 108, 72, COLORS.cyan);
  drawText(frame, "HANDOFF", 488, 211, COLORS.text, 2);
  drawText(frame, "MD + JSON", 486, 239, COLORS.cyan, 2);
}

function renderFreshTask(frame, subframe) {
  drawPanel(frame, COLORS.green);
  drawText(frame, "3  FRESH TASK VALIDATES", 48, 146, COLORS.green, 2);
  drawText(frame, "DO NOT TRUST THE SUMMARY BY DEFAULT", 48, 174, COLORS.text, 2);
  const items = ["CHECK BRANCH", "CHECK DIFF", "RE-RUN TESTS", "COMPARE EVIDENCE"];
  items.forEach((item, index) => {
    drawListItem(frame, item, 52, 204 + index * 22, index <= subframe ? COLORS.green : COLORS.border, index <= subframe);
  });
  fillRect(frame, 438, 205, 138, 56, COLORS.panel);
  strokeRect(frame, 438, 205, 138, 56, subframe >= 3 ? COLORS.green : COLORS.border, 2);
  centerText(frame, subframe >= 3 ? "VERIFIED" : "CHECKING", 507, 225, subframe >= 3 ? COLORS.green : COLORS.amber, 2);
}

function renderStaleClaim(frame, subframe) {
  drawPanel(frame, COLORS.red);
  drawText(frame, "4  STALE CLAIM DETECTED", 48, 146, COLORS.red, 2);
  drawText(frame, "RECORDED CLAIM", 52, 184, COLORS.muted, 1);
  drawText(frame, "TESTS PASS", 52, 201, COLORS.text, 2);
  drawText(frame, "CURRENT STATE", 52, 238, COLORS.muted, 1);
  drawText(frame, "WORKTREE CHANGED", 52, 255, COLORS.amber, 2);

  drawArrow(frame, 286, 215, 56, subframe % 2 === 0 ? COLORS.red : COLORS.amber);
  fillRect(frame, 360, 182, 216, 91, COLORS.panel);
  strokeRect(frame, 360, 182, 216, 91, COLORS.red, 2);
  drawCross(frame, 380, 201, COLORS.red);
  drawText(frame, "CLAIMED", 405, 199, COLORS.muted, 2);
  drawText(frame, "IS NOT", 405, 224, COLORS.red, 2);
  drawText(frame, "VERIFIED", 405, 249, COLORS.text, 2);
}

function renderSafeNext(frame, subframe) {
  drawPanel(frame, COLORS.amber);
  drawText(frame, "5  SAFE NEXT ACTION", 48, 146, COLORS.amber, 2);
  const steps = ["RE-RUN CHECKS", "REFRESH EVIDENCE", "CONTINUE FROM VERIFIED STATE"];
  steps.forEach((step, index) => {
    const active = index <= Math.min(2, subframe);
    fillRect(frame, 52, 188 + index * 29, 20, 20, active ? COLORS.green : COLORS.border);
    centerText(frame, String(index + 1), 62, 195 + index * 29, COLORS.navy, 1);
    drawText(frame, step, 86, 191 + index * 29, active ? COLORS.text : COLORS.muted, 2);
  });
  fillRect(frame, 428, 188, 148, 78, COLORS.panel);
  strokeRect(frame, 428, 188, 148, 78, subframe >= 3 ? COLORS.green : COLORS.amber, 2);
  centerText(frame, subframe >= 3 ? "READY" : "RECHECK", 502, 207, subframe >= 3 ? COLORS.green : COLORS.amber, 2);
  centerText(frame, "SAFE TO CONTINUE", 502, 239, COLORS.text, 1);
}

function renderFooter(frame, phase) {
  fillRect(frame, 24, 324, 592, 24, COLORS.panel);
  strokeRect(frame, 24, 324, 592, 24, COLORS.border);
  drawText(frame, "NO RAW CHAT  -  NO PRIVATE DATA  -  VERIFY BEFORE CONTINUING", 41, 333, COLORS.muted, 1);
  fillRect(frame, 24, 324, 6, 24, PHASES[phase].color);
}

function renderFrame(phase, subframe) {
  const frame = frameBuffer();
  drawBackground(frame);
  drawHeader(frame, phase, subframe);
  if (phase === 0) renderLongTask(frame, subframe);
  if (phase === 1) renderHandoff(frame, subframe);
  if (phase === 2) renderFreshTask(frame, subframe);
  if (phase === 3) renderStaleClaim(frame, subframe);
  if (phase === 4) renderSafeNext(frame, subframe);
  renderFooter(frame, phase);
  return frame;
}

class ByteWriter {
  constructor() {
    this.bytes = [];
  }

  byte(value) {
    this.bytes.push(value & 0xff);
  }

  word(value) {
    this.byte(value);
    this.byte(value >> 8);
  }

  ascii(text) {
    for (const character of text) this.byte(character.charCodeAt(0));
  }

  array(values) {
    for (const value of values) this.byte(value);
  }

  buffer() {
    return Buffer.from(this.bytes);
  }
}

class BitWriter {
  constructor() {
    this.bytes = [];
    this.current = 0;
    this.bitCount = 0;
  }

  code(value, bitLength) {
    this.current |= value << this.bitCount;
    this.bitCount += bitLength;
    while (this.bitCount >= 8) {
      this.bytes.push(this.current & 0xff);
      this.current >>>= 8;
      this.bitCount -= 8;
    }
  }

  finish() {
    if (this.bitCount > 0) this.bytes.push(this.current & 0xff);
    return this.bytes;
  }
}

function lzwEncode(indices, minimumCodeSize) {
  const clearCode = 1 << minimumCodeSize;
  const endCode = clearCode + 1;
  const bits = new BitWriter();
  let codeSize = minimumCodeSize + 1;
  let nextCode = endCode + 1;
  let dictionary = new Map();

  const reset = () => {
    codeSize = minimumCodeSize + 1;
    nextCode = endCode + 1;
    dictionary = new Map();
  };

  bits.code(clearCode, codeSize);
  let prefix = indices[0];
  for (let index = 1; index < indices.length; index += 1) {
    const suffix = indices[index];
    const key = prefix * 256 + suffix;
    const existing = dictionary.get(key);
    if (existing !== undefined) {
      prefix = existing;
      continue;
    }

    bits.code(prefix, codeSize);
    if (nextCode < 4096) {
      dictionary.set(key, nextCode);
      nextCode += 1;
      // A GIF decoder adds the matching dictionary entry after it reads the
      // following code. Keep the encoder one insertion ahead and grow the bit
      // width only when that following code will use the larger dictionary.
      if (nextCode > 1 << codeSize && codeSize < 12) codeSize += 1;
    } else {
      bits.code(clearCode, codeSize);
      reset();
    }
    prefix = suffix;
  }
  bits.code(prefix, codeSize);
  bits.code(endCode, codeSize);
  return bits.finish();
}

function writeSubBlocks(writer, bytes) {
  // Keep binary payloads friendly to simple text-oriented safety scanners.
  // A slash byte is always the final byte in a short GIF data sub-block, so
  // the following control-length byte cannot be mistaken for a Unix path.
  let offset = 0;
  while (offset < bytes.length) {
    const maximumEnd = Math.min(offset + 31, bytes.length);
    const nextSlash = bytes.indexOf(0x2f, offset);
    const end = nextSlash >= offset && nextSlash < maximumEnd ? nextSlash + 1 : maximumEnd;
    const chunk = bytes.slice(offset, end);
    writer.byte(chunk.length);
    writer.array(chunk);
    offset = end;
  }
  writer.byte(0);
}

function encodeGif(frames) {
  const writer = new ByteWriter();
  writer.ascii("GIF89a");
  writer.word(WIDTH);
  writer.word(HEIGHT);
  writer.byte(0xf3);
  writer.byte(COLORS.background);
  writer.byte(0);
  for (const color of PALETTE) writer.array(color);

  writer.array([0x21, 0xff, 0x0b]);
  writer.ascii("NETSCAPE2.0");
  writer.array([0x03, 0x01, 0x00, 0x00, 0x00]);

  for (const frame of frames) {
    writer.array([0x21, 0xf9, 0x04, 0x04]);
    writer.word(FRAME_DELAY_CS);
    writer.array([0x00, 0x00]);

    writer.byte(0x2c);
    writer.word(0);
    writer.word(0);
    writer.word(WIDTH);
    writer.word(HEIGHT);
    writer.byte(0);

    writer.byte(4);
    writeSubBlocks(writer, lzwEncode(frame, 4));
  }
  writer.byte(0x3b);
  return writer.buffer();
}

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "..");
const outputPath = resolve(
  repositoryRoot,
  process.argv[2] ?? "docs/assets/context-relay-dogfood-demo.gif",
);

const frames = [];
for (let phase = 0; phase < PHASES.length; phase += 1) {
  for (let subframe = 0; subframe < FRAMES_PER_PHASE; subframe += 1) {
    frames.push(renderFrame(phase, subframe));
  }
}

const gif = encodeGif(frames);
await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, gif);

const durationSeconds = (frames.length * FRAME_DELAY_CS) / 100;
const sha256 = createHash("sha256").update(gif).digest("hex");
process.stdout.write(
  `${JSON.stringify({ output: outputPath, width: WIDTH, height: HEIGHT, frames: frames.length, durationSeconds, bytes: gif.length, sha256 }, null, 2)}\n`,
);
