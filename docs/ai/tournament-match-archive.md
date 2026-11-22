# Navi historical tournament matches and streams — catalog and coverage

Reviewed: **22 November 2026**. This is a **partial, locally reviewed index** for Navi's public read-only `search_tournament_matches` tool. Neither the index nor a search result is an exhaustive bracket, a claim that unlisted games never occurred, or a live Friendly Wars match database.

## Architecture and evidence rules

- `src/ai/TournamentArchive.json` is a fixed repository-local catalog bundled in TypeScript. Searches neither browse the internet nor download media or accept user-chosen file paths.
- `src/ai/TournamentArchive.ts` validates unique match, tournament and recording IDs, **unique YouTube video IDs**, allowed Shotbow forum / YouTube evidence URLs, references, timestamps and bounded array sizes. Every match has **two to four named opposing clans**, backed by evidence; a four-clan event is one game, **not** six invented pairwise games.
- `src/ai/TournamentMatchSearch.ts` provides ranked, approximate, alias-aware, bounded search. Known team pairings outweigh an incorrect recalled map. For broad searches, request `offset: nextOffset` to continue: the first results are **not** the full list. Responses retain the existing roughly 4 KB tool budget and bounded inputs.
- Matches, recording uploads and recording-to-match associations have independent evidential status. A stream containing two games links to two match IDs; alternate-language perspectives of one game link to **one** match ID. Unknown `map`, `winner`, `playedOn`, `score` or segment time are omitted, not interpreted as a draw, a particular map, or evidence that a recording never existed.
- Official titles or results distinguish confirmed claims; community uploader/organiser reports have explicit attribution, with uncertain claims held back rather than converted into fixtures. Timestamps and playing dates are never inferred from uploads, captions alone, or elapsed video duration.
- The existing `F3 Entity` vs `F3`, `TP` vs `The Family`, `TT` vs historical `TeamTurkish`, `ZE` vs `Zero Effort`, and historical `rawr` vs `Rawr v2` distinctions remain unmerged. The 2020 source independently uses both `Team Turkish` and `TeamTurkish` and supports that narrowly scoped alias.

## Coverage: before and after this pass

| Tournament / edition                  | Before |    Now |    New | Basis                                                                                                     |
| ------------------------------------- | -----: | -----: | -----: | --------------------------------------------------------------------------------------------------------- |
| Shotbow 2023                          |      1 |  **1** |      0 | DDD–Agency official final; additional partial video titles lack both opponents                            |
| Shotbow 2024                          |      8 |  **8** |      0 | Existing recorded group, quarterfinal, semifinal and final fixtures; more group games remain unidentified |
| Friendly Wars community 2025          |      0 |  **0** |      0 | Aura first, F3 second are community-reported placements, **not** proof of a final match                   |
| Shotbow 2026                          |      5 | **16** | **11** | New officially titled first-round, four quarterfinal, two semifinal, and existing final recordings        |
| Shotbow Spring 2018 / Jan 2019 final  |      0 |  **1** |  **1** | One officially titled **four-clan** 2018 quarterfinal                                                     |
| Team Nexus Spring 2020                |      0 |  **9** |  **9** | Nine completed four-clan wars with placings published by the event organiser                              |
| Team Nexus Summer/Fall 2020           |      0 |  **0** |      0 | One official Summer opener recording located; competing clan roster not independently proved              |
| Team Nexus Mushroom (year unresolved) |      0 |  **0** |      0 | Placements/history alone cannot establish a fixture                                                       |
| **Total unique matches**              | **14** | **35** | **21** | Deduplicated fixture identities                                                                           |

**Recording coverage:** **15 → 33 unique YouTube records** (**+18**). **25** recordings have at least one match association (previously **12**); **8** are intentionally **unassociated**. Of those eight, **five** are videos with identified metadata but incomplete opponents (2023 lPirlo quarterfinal, 2023 DDD-labelled “vs 01” upload, 2020 Team Nexus Summer opener, and two 2024 Rawr v2-channel uploads whose titles name only APL or F3), **one** is the lPirlo 2023 tournament announcement rather than a match, and **two** are user-supplied IDs with inaccessible metadata. These eight are research records, **not proven standalone fixtures**.

At least one 2026 official upload (`LT_HJV_3kJ0`) explicitly names **two different fixtures** (GRIM–MRK, ANNL–F3); both are linked to the single recording, with no invented start times. Two separately uploaded official broadcasts (`giZfDpHPY2E` and `aPm_WNvS8mQ`) depict **one** ANNL–SFJ quarterfinal rather than two matches. The latter association is also supported by existing manually reviewed image/phase alignment evidence in the separate AnniArchive test corpus.

## Source discoveries successfully indexed

### Shotbow 2026 official video titles

The following **new** directly indexed recordings independently name both competing sides; a title supports the fixture, not its winner, game map, match score, exact date or unlisted video chapters:

| Official title / fixture                    | Watch link                                  | Stage established by title                         |
| ------------------------------------------- | ------------------------------------------- | -------------------------------------------------- |
| ANNL vs GRIM                                | https://www.youtube.com/watch?v=6QkDb6neYJc | Not stated                                         |
| ZE vs GRIM                                  | https://www.youtube.com/watch?v=EDLBbEdRBMQ | Not stated; ZE is not assumed to equal Zero Effort |
| TT vs AWF                                   | https://www.youtube.com/watch?v=0-BH43j-qQY | Not stated                                         |
| APL vs HELP                                 | https://www.youtube.com/watch?v=l0KBbrfh4Kc | Not stated                                         |
| TT vs HELP                                  | https://www.youtube.com/watch?v=hhAukvJG9Qk | Not stated                                         |
| ANNL vs SFJ (English broadcast)             | https://www.youtube.com/watch?v=giZfDpHPY2E | Quarterfinal                                       |
| ANNL vs SFJ (Japanese broadcast, same game) | https://www.youtube.com/watch?v=aPm_WNvS8mQ | Quarterfinal #2                                    |
| TT vs F3                                    | https://www.youtube.com/watch?v=WAE42dUSn1w | Quarterfinal                                       |
| HELP vs GRIM                                | https://www.youtube.com/watch?v=i6WaS2ofdxE | Quarterfinal                                       |
| AURA vs MRK                                 | https://www.youtube.com/watch?v=anuw9S9Jmps | Quarterfinal                                       |
| AURA vs F3                                  | https://www.youtube.com/watch?v=Z4zyrk1QJD8 | Semifinal                                          |
| ANNL vs HELP                                | https://www.youtube.com/watch?v=FI1Dt5AdIsI | Semifinal #2                                       |

Existing Shotbow 2026 watch URLs and their match references remain unchanged: [TT–SFJ](https://www.youtube.com/watch?v=sMedcItfrZs), [GRIM–MRK and ANNL–F3 in one recording](https://www.youtube.com/watch?v=LT_HJV_3kJ0), [APL–AWF](https://www.youtube.com/watch?v=47Wz8hHsxqE) and [ANNL–AURA final](https://www.youtube.com/watch?v=zXGzDq8b5nU). Official [2026 tournament registration](https://shotbow.net/forum/threads/annihilation-2026-tournament.432532/) confirms the edition; [September staff recap](https://shotbow.net/forum/portal/?page=2) establishes Aura's title, not other individual results.

### Team Nexus 2020 completed events

The organiser's [Clan War Events by Team Nexus schedule and reported finishes](https://shotbow.net/forum/threads/clan-war-events-by-team-nexus.400408/) supplies **nine completed games**. Each is one real four-clan fixture with a reported first-place clan. These are community-organised events, not Shotbow's 2026/2024 1v1 brackets. The organiser reused the `#7` event label for three distinct fixtures; archive IDs `tn20-spring-07a`, `07b`, and `07c` keep the different team compositions separate. The listing sometimes describes scheduled calendar dates alongside results; **played-on dates are intentionally omitted** until separately reviewed. No direct video links were established for these nine games.

### 2018 four-clan quarterfinal

[Envy vs ATC vs LOVE vs The Blue Hearts — Annihilation Spring 2018 Quarter Final](https://www.youtube.com/watch?v=msPjB6nmmXE) is an official title with all four participants, indexed as **one** match. This does **not** prove the contestants or winner of the January 2019 final. Existing bracket and [2019 recap](https://shotbow.net/forum/threads/the-year-ahead-2019-dentrils-new-moon-february-2019.392056/) remain contextual sources.

### Unassociated but identifiable recordings

- [TN Summer Season Opener — The Great Clan War, 3v3v3v3](https://www.youtube.com/watch?v=SdwPHjJbCsQ), official, July 2020 upload: title has no reliable twelve-clan composition.
- [YALEAGENCY — Cuartos de final, Tournament 2023](https://www.youtube.com/watch?v=1Nu_Db28r5s), lPirlo, Spanish: opponent not established by accessible metadata.
- [Annihilation Tournament 2023 — vs 01](https://www.youtube.com/watch?v=jQIIe5rVFUI), DDD channel: title alone does not explicitly identify both sides, so do **not** infer that DDD itself was a contestant.
- [2024 tournament — vs APL](https://www.youtube.com/watch?v=N9TTVzHOQ78) and [2024 tournament — vs F3](https://www.youtube.com/watch?v=1izlnN61wJo), Rawr v2 channel: credible recordings, but their titles identify only one opposing side. Uploader identity is **not** sufficient alone to assert the second team or a rematch.

The AnniArchive repository's `tests/golden/manifest.json`, `tests/golden/metadata/*.json`, and `tests/golden/annotations/` were read **without running it or modifying its files**. Existing 2026 and 2018 records from that corpus were cross-checked with official indexed titles; its sample label “candidate assignment” is not sufficient by itself for unknown opponent or outcome claims.

## Playlist and channel discovery — attempted vs accessed

| Source / method                                                           | What was actually accessible                                                                                                    | Outcome                                                                                                                                                                                       |
| ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| https://www.youtube.com/@ShotbowOfficial/playlists                        | Direct playlist listing yielded no reliable entries                                                                             | **Zero playlists enumerated**, no verified playlist URL                                                                                                                                       |
| https://www.youtube.com/@ShotbowOfficial/videos and `/streams`            | Direct listing/cache access inadequate for bulk enumeration                                                                     | Matched titles via indexed **individual official watch results**, not a full channel export                                                                                                   |
| https://www.youtube.com/@lPirlo/playlists, `/videos`, `/streams`          | Direct playlist/channel listings not reliably enumerated                                                                        | 2023 promotion and Spanish quarterfinal located by alternative metadata/search                                                                                                                |
| Public indexed YouTube/Shotbow search                                     | Searches by tournament year 2023/2024/2026; “quarterfinal”, “semifinal”, “vs”, clan tags, lPirlo and Shotbow; community uploads | **12 new official 2026 video records**, one official 2018 record and five other identified lead uploads (including two 2024 Rawr v2-channel uploads); full channel coverage cannot be claimed |
| Shotbow tournament registration, staff recap and Team Nexus forum threads | Individual public posts readable                                                                                                | Nine separate completed 2020 fixtures validated; registration-only lists not turned into matches                                                                                              |
| Friendly Wars 2025 forum/discovery                                        | A “Friendly Wars 2025 1v1 Tourney” thread listing surfaced, without trustworthy fixture/recording content                       | **No invented 2025 matches**                                                                                                                                                                  |
| Two original user-provided YouTube IDs                                    | `icpcNFnAbsU` and `4cFKAafjsOA` not reliably resolvable                                                                         | Retain as **unverified** with null channel/title and no match segments                                                                                                                        |

**Successfully enumerated playlist entries: 0. Identified, verified playlist URLs: 0.** Search engine results are not an exhaustive channel listing; videos referenced by a description but without retrievable direct IDs remain unindexed as recordings. **No full streams were watched or chapter/timestamp offsets established in this indexing pass.** The individual indexed source titles/metadata prove named match associations only, not unseen game contents. The overall video-lead count is the 33 distinct catalog records, not a count of every search hit inspected; inaccessible listing result counts cannot be determined defensibly.

Existing 2024 sources remain [official QF #2](https://www.youtube.com/watch?v=JcT99O71RiQ), [QF #3](https://www.youtube.com/watch?v=4qVyI8mY4CE), [QF #4](https://www.youtube.com/watch?v=oMISKDkIYdM), [SF #1](https://www.youtube.com/watch?v=lSCo4yBbsck) and [grand final](https://www.youtube.com/watch?v=En6xfvoBlSQ). Another official upload's description names Giew–MRK QF #1, but its own video ID was not verified. [March 2024 staff recap](https://shotbow.net/forum/threads/dentrils-new-moon-march-2024.423679/) states eleven tournament clan wars that month, not eleven identifiable pairings. Existing [2023 DDD–Agency final](https://shotbow.net/forum/threads/dentrils-new-moon-august-2023.421489/) remains confirmed; additional stage fixtures are unknown.

## Future enrichment and outstanding research

1. **Breadth:** obtain full Shotbow and lPirlo channel/playlist exports (including archived livestreams) where permitted; identify missing 2023/2024 group fixtures, the 2024 second semifinal, older Team Nexus games, and legitimate FW 2025 played results. Repeat official-title cross-check and deduplication.
2. **Unassociated video leads:** inspect descriptions or independently review video content of the five newly identified but unassociated recordings (including the two 2024 Rawr v2 uploads), and resolve the two original inaccessible IDs; never infer full pairings from channel identity.
3. **Per-match facts:** establish maps, winners, scores and actual play dates from reliable primary evidence; published **upload dates are not play dates**.
4. **Segments:** capture real chapters, timestamp offsets and perspective-to-match associations only when independently verified, especially the 2026 two-match broadcast.
5. **Coverage labels:** distinguish official title, event-organiser first-place reporting, community streamer title, and unknowns; do not merge teams across unrelated years on acronym alone.

## Maintenance and safe behaviour

Add only fixture records with a direct source proving every named side and event association, and preserve existing stable IDs. Reuse match IDs for multiple perspectives and recording IDs for multiple known fixtures in the same stream. If two same-clan pairings are different fixtures only when positively established, keep them separate; otherwise document ambiguity. Run `npm run typecheck`, `npm run tests`, targeted `npx eslint` and `npx prettier --check` after updates. The live bot's membership and access-control checks are unchanged; the archive never autoprefetches for routine current Friendly Wars help. Search replies should state **“I have no indexed fixture proving that pairing,”** not “they never played.”
