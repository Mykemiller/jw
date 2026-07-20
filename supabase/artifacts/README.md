# Shovels closeout artifacts (FAR-371 / CC-SHOVELS-CLOSEOUT-1.0)

Generated 2026-07-20 from `shovels_permit_snapshots` (Supabase `ycadmmngkdhvpcsrcuaq`).

- **`shovels_registry_coverage.csv`** — per Jurisdiction Posture Registry (metro) record: Shovels coverage
  status + REG-09 permit count + RSC-05 median approval days + last-synced date. 106 US registry
  jurisdictions (63 Covered / 43 Not Covered); international registry rows classify as `Unknown`
  (outside Shovels' US coverage). Each registry metro is rolled up from the county its `geo_key`
  (county FIPS) points at — county-matched permits plus the county's constituent places' permits.
  This is the source for the FAR-270 Airtable field population (`update_records_for_table` by
  `airtable_record_id`), pending an approved bulk write.

- **`shovels_coverage_gap_ambassador_candidates.csv`** — the 43 US registry jurisdictions with zero
  matched Shovels permits (FAR-264 Ambassador-program shortlist).

Airtable target: base `appxfti7VuoHYUeu6`, table `tblAZB4CjCBGHREKi`. Field IDs —
`Shovels: Coverage Status` `fldirxNrVK5t4pb9a`, `Shovels: Last Synced` `fldSUxdKkjp4nJits`,
`REG-09: Permits (Shovels)` `fldN1WTvGteS1XqaV`, `RSC-05: Median Approval Days (Shovels)` `fldR3leRIbnN9rarm`.
