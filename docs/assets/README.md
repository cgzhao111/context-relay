# Demo assets

`context-relay-dogfood-demo.gif` is a deterministic, synthetic walkthrough of the project's core safety loop:

1. a long task accumulates work;
2. an evidence-backed handoff records checkable state;
3. a fresh task validates that state;
4. a stale claim is detected after the working state changes; and
5. the receiver chooses a safe next action.

The 75-second story is condensed into a 15-second looping GIF. It contains no copied conversation, account data, repository identifiers, private paths, or real project metrics.

Regenerate it from the repository root:

```bash
node tools/render-dogfood-demo.mjs
```

The script uses only Node.js built-ins and prints the output dimensions, frame count, duration, byte size, and SHA-256 digest.
