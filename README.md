# huaycheck-data

Aggregated "เลขยอดนิยม" (popular lucky numbers) for the upcoming Thai
government lottery draw, scraped from public Thai news articles (Kapook
lottery hub, Sanook lotto) every 6 hours by GitHub Actions.

Consumed by the HuayCheck app via:

```
https://raw.githubusercontent.com/nipitphand-maker/huaycheck-data/main/data/lucky-numbers.json
```

## Schema (v1)

```jsonc
{
  "schemaVersion": 1,
  "drawDate": "2026-06-16",          // ISO date of the target draw
  "drawDateThai": "16 มิถุนายน 2569",
  "generatedAt": "2026-06-12T05:36:38.315Z",
  "sourceCount": 8,
  "sources": [
    {
      "site": "kapook",              // kapook | sanook
      "name": "หวยคำชะโนด",          // สำนัก attribution shown in the app
      "url": "https://...",
      "lead": ["3", "5"],            // เลขเด่น (1-2 digits)
      "two": ["98", "90"],           // เลขท้าย 2 ตัว
      "three": ["825"]               // เลขท้าย 3 ตัว
    }
  ],
  "topTwo":   [{ "digits": "59", "mentions": 3 }],  // cross-source counts
  "topThree": [{ "digits": "124", "mentions": 1 }]
}
```

## Notes

- Data is statistical/entertainment information compiled from public news
  reporting. It is not a prediction and guarantees nothing.
- ไม่เกี่ยวข้องกับสำนักงานสลากกินแบ่งรัฐบาล (GLO).
- An empty `sources` array right after a draw is normal — articles for the
  next draw haven't been published yet.

Run locally: `node scrape.mjs` (Node 20+, no dependencies).

## Verified Thai results

`data/thai-latest.json` is the app-controlled, complete-result feed consumed
before direct webpage scrapers:

```
https://raw.githubusercontent.com/nipitphand-maker/huaycheck-data/main/data/thai-latest.json
```

The `Collect verified Thai lottery results` workflow runs every five minutes in
the 14:15-17:55 ICT draw window. It parses Sanook rendered result cards and
Thairath's server-rendered Next.js result state independently, validates every
prize count and digit width, and only publishes a complete result. When both
sources are complete, the first prize and back-two result must agree.

For an incident, open the workflow in GitHub Actions and use **Run workflow**.
If both sites changed at once, a maintainer may place a fully validated result
in `data/thai-override.json` and set `enabled` to `true`; disable it again once
the collector is repaired. The app rejects malformed, partial, or wrong-date
override data.
