# The health score

How the number is built, what it means, and — more importantly — when it is withheld.

Implemented in `src/engine/health.js`. Tested in `tests/unit/health.test.js`.

---

## 1. What the score is

A weighted average of eight component scores, where each component is built from evidence
deltas. It is a summary of **the evidence VERIDEX was able to collect**, which is a
narrower thing than "the health of the machine".

| Component | Weight | Evidence sources |
| --- | --- | --- |
| Processor | 1.2 | temperature, throttling, error counters |
| Graphics | 1.0 | adapter state, driver problem codes |
| Memory | 1.1 | module configuration, capacity, errors |
| Storage | 1.3 | SMART attributes, NVMe wear, free space |
| Battery | 0.9 | wear percentage, design vs full charge |
| Thermal | 1.0 | sensor readings, sustained-load behaviour |
| Drivers | 1.0 | problem codes, ages, missing devices |
| Security | 0.8 | Defender, firewall, BitLocker, Secure Boot, TPM |

Storage carries the most weight because it is the component most likely to fail in a way
that destroys data. Security carries the least because a disabled firewall on a machine
that never leaves a desk is a policy question, not a hardware fault.

---

## 2. Components, not vibes

Each component is scored from `Evidence` entries — a `delta` and a reason. A component
with no usable evidence is **`Unrated`**, not 100 and not 0:

```js
if (usable.length === 0) {
  return { score: null, status: UNRATED, rating: 'Unrated',
           missing: ['no usable evidence was collected'] };
}
```

`null` is a real answer here. Treating "could not read" as "fine" is the single most
damaging thing a diagnostic tool can do, because it converts a gap into reassurance.

---

## 3. Coverage gating

The overall score is only published when enough of the machine was measured.

```
coveragePercent = (weight of rated components / total weight) × 100
```

| Coverage | Result |
| --- | --- |
| **< 50 %** | **No score.** `score: null`, rating `Unrated`, `gated: true`, reason stated |
| **50–80 %** | Score published, **capped at 84** (`Fair`), `capped: true` |
| **≥ 80 %** | Real score |

### Why this exists

A real run on a Linux host rated **one** component (the processor) at 100 and printed:

```
100 / 100 · Good        coverage 13.2%        rated 1 of 8
```

That is the worst possible output for this product: a perfect score, in green, from a
machine that was almost entirely unmeasured. Every component except the processor was
`Unrated`, and a reader would have concluded the machine was healthy.

The gate makes that output impossible:

```
Score withheld
Only 13.2% of the weighted assessment surface could be measured (1 of 8 components).
A score is withheld: an average over such a small part of the machine would look like
a verdict on the whole machine.
```

### Why 50 and 80

- **50 %** is the point below which the rated components are not a majority of the
  weighted surface. Below it, the average is a statement about a minority being applied
  to the whole.
- **80 %** is the point at which a "Good" rating is defensible. Between the two, the score
  is real but capped, so a machine missing a fifth of its evidence can read *Fair* and
  never *Good*.

Both thresholds are exported on the assessment as `gatingThresholds` rather than hidden as
literals, so a reader of a report can see the rule that produced it.

### Where the reason appears

`gatingNote` is carried into every output:

- the dashboard, as a warning callout
- the PDF, under the assessment box
- the HTML report, in the summary
- the JSON, as `assessment.gated`, `assessment.capped`, `assessment.gatingNote`
- the certificate, whose verdict reads `Not assessed — insufficient evidence`

`rawScore` is retained in the assessment so the average is still inspectable; it is never
presented as the score.

---

## 4. Ratings

| Score | Rating |
| --- | --- |
| ≥ 90 | Good |
| ≥ 70 | Fair |
| ≥ 40 | Poor |
| < 40 | Critical |
| `null` | Unrated |

`statusForScore()` maps the same numbers onto the `Status` vocabulary for the report, so
the rating word and the status badge never disagree.

---

## 5. Manual observations are not evidence

The manual checklist records what a human saw: a rattle, a loose hinge, a key that misses.
Those answers live in `coverage.manual` and `report.manualCoverage`.

They are **never folded into the score**, and never into field coverage. A person's
opinion and an instrument's reading are different kinds of claim, and blending them would
make both unreadable. The manual results appear in the report as their own section.

---

## 6. The disclaimer

Every assessment carries one, and it says what the number is not:

> This score summarises the evidence VERIDEX was able to collect. It is not a
> certification, a guarantee against future failure, or a substitute for physical
> inspection. Components without evidence are unrated and are excluded from the score
> rather than counted as healthy.

When the score is withheld the PDF replaces it with a stronger statement:

> No score is reported because the collected evidence covers too little of this machine
> to support one. It is not a certification, and it is not a statement that the machine is
> healthy.

---

## 7. Raising coverage

The score appears when the machine has been measured. In practice that means:

1. **Run elevated** if you can. Elevation unlocks Driver store, servicing inventory, TPM
   and several storage counters — often the difference between 40 % and 70 %.
2. **Wait for the slow tasks.** `dxdiag` takes 5–25 seconds; leaving before it finishes
   leaves the DirectX fields unrated.
3. **Accept the consent prompts** for driver export and the write benchmark if you want
   those components scored.
4. **Read the unrated list.** Each entry states what is missing, and the reason is usually
   actionable.

A desktop with no battery will never reach 100 % coverage: battery is `NOT_APPLICABLE`,
which is a correct answer and still counts against the weighted surface. That is why the
full-coverage threshold is 80 % rather than 100 %.
