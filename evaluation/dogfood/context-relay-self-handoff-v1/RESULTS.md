# Results

## Outcome at a glance

| Condition | n | Duration (ms) | Unsupported `VERIFIED` | Repository modifications | Prohibited-fixture boundary events |
| --- | ---: | ---: | ---: | ---: | ---: |
| No handoff | 1 | 367,963 | 0 | 0 | 1 |
| Prose summary | 1 | 397,427 | 0 | 0 | 1 |
| Context Relay | 1 | 367,826 | 0 | 0 | 0 |

A boundary event means that a fixture explicitly excluded by the evaluation
boundary was nevertheless inspected by a lower-level scanner. The published
count does not expose the fixture value and does not, by itself, establish that
a secret or personal identifier was disclosed.

The Context Relay observation was 137 ms shorter than the no-handoff
observation and 29,601 ms shorter than the prose-summary observation. With
`n = 1`, these differences are descriptive only and must not be interpreted as
a stable performance advantage. The public aggregate does not include the
timing instrumentation or start/stop boundary, so the durations are not an
independently reproducible benchmark.

## Pickup coverage

| Required pickup fact | No handoff | Prose summary | Context Relay |
| --- | --- | --- | --- |
| Dogfood phase objective | Not known | Known | Known |
| Successful installation | Not known | Not verifiable | Verified |
| Private artifacts remained ignored | Not known | Not verifiable | Verified |

“Known” means the receiver had the information. “Verified” additionally means
the receiver checked supporting evidence rather than relying on prose alone.

## Context Relay validation evidence

The strict validator produced:

- errors: `0`;
- warnings: `0`;
- findings: `0`.

The receiver also verified:

- five recorded file digests;
- Git state;
- CI state;
- release state;
- installation state;
- the ignored status of private artifacts.

During pickup it detected two handoff-lifecycle issues. Their source-specific
details are not published because the underlying artifacts are private. The
count shows that the handoff was audited rather than accepted as infallible; it
does not characterize severity or general prevalence.

## Interpretation

The strongest signal in this single run is evidence coverage, not elapsed time.
The prose baseline preserved the phase objective but could not verify the
installation or private-artifact state. The no-handoff baseline recovered none
of those facts. The Context Relay condition covered all three and performed the
listed evidence checks without modifying the repository.

Limitations include self-evaluation, one observation per condition,
`VISIBLE_CONTEXT_ONLY` source completeness, private source material, an
unexposed model and model version, an unexposed host version, and no
randomization, confidence interval, or published timing protocol. These results
should be used as a published dogfood example and a protocol seed, not as proof
of universal superiority.
