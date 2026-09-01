# Apply answer bank -- FORMAT REFERENCE ONLY (de-identified). The real file, data/apply-answers.md, is
# gitignored (personal data) and is parsed by src/apply/answers.js's parseAnswerBank(). Copy this file to
# data/apply-answers.md and replace every value with your own. See src/apply/answers.js's module doc
# comment for the full grammar and the exact-match-only matching rules.
#
# Grammar summary:
#   - Blank lines and lines starting with a single "#" are comments, ignored anywhere in the file.
#   - Before the first "## key" section, the only recognized line is "salary_floor: <number>" (optional,
#     at most one).
#   - "## key" starts a new fact. key must match ^[a-z][a-z0-9_]*$ and must be unique in the file.
#   - Inside a section, each line is matched independently by its own prefix -- order does not matter,
#     and you can freely reorder, insert, or delete lines by hand:
#       type: enum | boolean | text | multiselect          (required, exactly one)
#       value: <the answer>                                 (required for enum/boolean/multiselect)
#       aliases: <exact question label as a site phrases it> [:: invert]
#       learned: <exact question label, already confirmed correct for this key>
#   - A label (from aliases: or learned:) must resolve to exactly one key in the WHOLE file. The same
#     label appearing twice -- even under the same key -- is a parse error, not a silent overwrite.
#   - "aliases: ... :: invert" is ONLY valid on a boolean-type key: it means "on this alias, a 'yes'
#     answer to the site's phrasing means this fact is FALSE" (e.g. "are you authorized to work without
#     sponsorship" is the inverse phrasing of "do you need sponsorship").
#   - A "learned:" label auto-answers. An "aliases:" label only ever produces a parked suggestion for a
#     human to confirm; confirming it is what promotes it to "learned:" (a later slice's UI action).

salary_floor: 150000

## eeo_gender
type: enum
value: prefer_not_to_answer
aliases: what is your gender
aliases: gender identity

## eeo_race_ethnicity
type: enum
value: decline_to_answer
aliases: race/ethnicity
aliases: what is your race

## eeo_disability
type: enum
value: no_disability
aliases: do you have a disability

## eeo_veteran
type: enum
value: not_protected_veteran
aliases: veteran status

## work_authorization
type: boolean
value: true
aliases: are you legally authorized to work in this country

## sponsorship_needed
type: boolean
value: false
aliases: will you now or in the future require visa sponsorship
aliases: are you legally authorized to work without sponsorship :: invert

## over_18
type: boolean
value: true
aliases: are you at least 18 years of age

## relocation
type: boolean
value: false
aliases: are you willing to relocate

## remote_preference
type: enum
value: remote_preferred
aliases: what is your work location preference

## how_heard
type: text
aliases: how did you hear about this position

## previous_employee
type: boolean
value: false
aliases: have you previously worked for this company

## non_compete
type: boolean
value: false
aliases: are you subject to a non-compete agreement
