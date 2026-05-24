# Evil Islands Universal Mod — Polish localization spec

## Scope

Create a Polish localization for `Kyr4l/ei-universal-mod`, initially as a separate language pair:

- `resources/universal-mod/res-texts/texts-pol_res`
- `resources/universal-mod/res-texts/textslmp-pol_res`
- packed outputs: `texts-pol.res`, `textslmp-pol.res`

Do not overwrite `eng`, `fra`, or `kor` sources. The release-side switcher already discovers `texts-<lang>.res` plus matching `textslmp-<lang>.res`, so `pol` should work with the existing `switchlang.bat` pattern after packing.

## Source format found

Canonical editable sources are already unpacked in the repo:

- `resources/universal-mod/res-texts/texts-eng_res`: 232 files, item/material/perk/string text.
- `resources/universal-mod/res-texts/textslmp-eng_res`: 27 files, LMP map/script/unit text.

Release files under `Universal-Mod/res/lang/*.res` are packed archives. I verified that `texts-eng.res`, `textslmp-eng.res`, `texts-fra.res`, and `textslmp-fra.res` unpack byte-for-byte to the matching `resources/universal-mod/res-texts/*_res` directories.

Observed `.res` archive shape:

- little-endian header, signature `0x019ce23c`, file count, file-table offset, unknown/reserved field;
- file payloads first;
- fixed-size file table records;
- concatenated file names at the end.

We should prefer editing the unpacked directories and using the mod’s pack pipeline. A small pure script packer/unpacker is possible later if Wine/eipacker becomes annoying.

## Polish reference found

A full Polish localization archive is available locally at:

`/Users/aleksander/Downloads/Evil Islands - Spolszczenie/Evil Islands - Spolszczenie/Res`

Relevant files:

- `texts.res`: 3,170 packed entries, mostly base-game text.
- `textslmp.res`: 397 packed entries, base-game LMP/dialogue text.
- Other Polish resource archives are present too: `database.res`, `databaselmp.res`, `menus.res`, `speech.res`, etc.

The Polish text payloads use Windows-1250 for Polish diacritics. Example: `PERK Melee` decodes correctly as CP1250 (`Broń kontaktowa`, `Umiejętność...`) and incorrectly as UTF-8. Filenames inside the archive are ASCII/UTF-8-compatible.

Comparison with Universal Mod English source:

- `texts-eng_res`: 232 mod entries; 21 have matching keys in the Polish `texts.res`, 211 are missing and need translation or adaptation.
- `textslmp-eng_res`: 27 mod entries; 4 have matching keys in Polish `textslmp.res`, 23 are missing.
- Exact overlap keys include vanilla terms such as `PERK Melee`, several `... Malachite` weapons, and `UNIT lmp_Human_Gipath_Fighter_2`; treat them as translation memory only after checking the English source still says the same thing. Some matching keys have different content in Universal Mod, e.g. `briefing intro_4k`, so key match alone is not safe.

Use the Polish archive as glossary/reference for vanilla terminology, not as a blind replacement for Universal Mod text: most Universal Mod additions are not present in the Polish base archive.


## Existing pack pipeline

`tools/ei-multitool/makemod.sh` packs text directories via:

```sh
for restexts in "$resxtextsdir"/*_res; do
    packedtexts="${restexts%_res}.res"
    wine bin/eipacker.exe /pack "$restexts" && mv -v "$packedtexts" "$moddir"/res/lang/
done
```

Then it copies English defaults into `res/texts.res` and `res/textslmp.res`. For Polish release, either run the normal pack and use `switchlang.bat`, or additionally copy `texts-pol.res` / `textslmp-pol.res` to the default names for a Polish-first build.

## Hard preservation rules

- Preserve every filename exactly, except only the language directory suffix changes from `eng` to `pol`.
- Preserve command/control lines in LMP files:
  - lines beginning with `#`, e.g. `#show`, `#ANIMATION`, `#CAMERA`, `#phrase`;
  - numeric map coordinates and resource identifiers in `map-lmp.txt`;
  - unit/resource keys embedded in filenames.
- Preserve placeholders, tags, escapes, and line breaks if any appear in later files.
- Preserve CRLF where the source file uses CRLF.
- Keep one logical item file as `Name` on first line, description on following line(s).
- Do not translate internal identifiers: `Gipat_Brigand_Boots`, `Wolf_Hide`, `MPGame1`, etc.

## Encoding policy

Current source data is not perfectly uniform:

- English files are ASCII/UTF-8 clean.
- Many French `texts-fra_res` files are UTF-8, but some French files are single-byte CP1252.
- Korean files are mostly non-UTF-8 legacy encoding.

For Polish, use Windows-1250 as the target encoding unless an in-game smoke test proves UTF-8 renders correctly in the exact Universal Mod path. The existing Polish localization in Downloads stores Polish glyphs as CP1250, and that is the safest default for game compatibility. Do not mix encodings inside `pol`.

## Localization style

Target: natural Polish localization, not literal translation.

- UI/items: concise, readable, game-like Polish.
- Descriptions: keep the rough/dark humor where present, but avoid clunky calques.
- Dialogue: preserve intent and tone; memes/slang may be localized if it sounds better in Polish.
- Proper nouns: keep stable until glossary is chosen. Default: keep world/place names close to game spelling (`Gipat`, `Hadagan/Khadagan`, `Ingos`, `Suslanger`, `Jigran`).
- Mechanical terms: prefer clear Polish over English unless the community term is clearly English.

Initial glossary candidates:

| EN | PL candidate |
| --- | --- |
| Melee | Walka wręcz |
| Brigand | Bandyta / brygant — choose one globally |
| magic wand | różdżka magiczna / różdżka — choose by UI width |
| hide | skóra |
| gauntlets | rękawice / karwasze — depends on item class |
| leggings | nogawice / nagolenice — depends on armor slot |
| breastplate | napierśnik |
| cloak | płaszcz |
| mithrill | mithrill, mithrillowy |

## QA checks before shipping full translation

1. File set parity:
   - `texts-pol_res` has exactly the same filenames as `texts-eng_res`.
   - `textslmp-pol_res` has exactly the same filenames as `textslmp-eng_res`.
2. Structural lint:
   - all `#...` command lines in LMP files unchanged;
   - map/resource coordinate blocks unchanged;
   - no accidental translation of internal identifiers.
3. Archive roundtrip:
   - pack `*_pol_res` to `.res`;
   - unpack/parse packed output and compare filenames and bytes to source payloads.
4. In-game smoke:
   - language switch sees `pol`;
   - item tooltip renders Polish diacritics;
   - LMP briefing runs and shows translated dialogue without breaking camera/phrases;
   - map loads after switching language.

## Translation samples, not final glossary

### Item

Source: `texts-eng_res/ARMOR Gipat_Brigand_Boots Hyena_Hide`

```text
Hyena hide boots
Walk confidently with these durable boots.
```

Localized sample:

```text
Buty ze skóry hieny
Pewny krok i solidna ochrona dzięki trwałej skórze hieny.
```

### Material with tone

Source: `texts-eng_res/MATERIAL Jute`

```text
Jute
A rough, scratchy fabric barely suitable for clothing. Cheap and disposable, just like those who wear it.
```

Localized sample:

```text
Juta
Szorstka, drapiąca tkanina, ledwie nadająca się na ubrania. Tania i jednorazowa — jak ci, którzy ją noszą.
```

### Mechanic/perk

Source: `texts-eng_res/PERK Melee`

```text
Melee
The skill in using close combat weapons - knives, axes, spears, etc. The outcome of a character's attack (the chances that they hit enemies) is determined by their skill with this particular type of weapon (Skill) and affected by their Dexterity.
```

Localized sample:

```text
Walka wręcz
Umiejętność posługiwania się bronią do walki z bliska — nożami, toporami, włóczniami itd. Wynik ataku postaci, czyli szansa trafienia przeciwnika, zależy od biegłości w danym typie broni oraz od Zręczności.
```

### Weapon

Source: `texts-eng_res/WEAPON Komposite_Bow Mithrill`

```text
Mithrill composite bow
Strong and powerful, but there are better bows out there!
```

Localized sample:

```text
Mithrillowy łuk kompozytowy
Mocny i niezawodny, choć istnieją jeszcze lepsze łuki.
```

### Quest item

Source: `texts-eng_res/QITEM Wand_9 Diamond`

```text
Diamond magic wand
A wand made of pure diamond. More magical power cannot be found in any other wand.
```

Localized sample:

```text
Diamentowa różdżka magiczna
Różdżka z czystego diamentu. Trudno o większą moc magiczną.
```

### LMP dialogue

Source: `textslmp-eng_res/briefing intro_4k`

```text
Get to know the artisan
#show Hero
#show Stark
#ANIMATION 5
#CAMERA 11
#phrase Stark 1
So are you the strangers who came through the old portal?
#ANIMATION 15
#CAMERA 10
#phrase Hero 2
Nah, we just spawned here cause it's a multiplayer lobby.
#phrase Stark 3
bruh wtf...
```

Localized sample, preserving control lines:

```text
Poznaj rzemieślnika
#show Hero
#show Stark
#ANIMATION 5
#CAMERA 11
#phrase Stark 1
To wy jesteście tymi obcymi, którzy przeszli przez stary portal?
#ANIMATION 15
#CAMERA 10
#phrase Hero 2
Nie, po prostu zrespiliśmy się w lobby multiplayera.
#phrase Stark 3
stary, co tu się...
```

### Unit name

Source: `textslmp-eng_res/UNIT lmp_Human_Gipath_Fighter_2`

```text
Unexperienced Brigand
```

Localized sample:

```text
Niedoświadczony bandyta
```

## Agent prompt for translation pass

Use this prompt when delegating the actual localization work to an implementation/translation agent:

```text
You are localizing Evil Islands Universal Mod into Polish.

Inputs:
- Universal Mod English editable sources:
  - resources/universal-mod/res-texts/texts-eng_res
  - resources/universal-mod/res-texts/textslmp-eng_res
- Existing Polish vanilla reference archive:
  - /Users/aleksander/Downloads/Evil Islands - Spolszczenie/Evil Islands - Spolszczenie/Res/texts.res
  - /Users/aleksander/Downloads/Evil Islands - Spolszczenie/Evil Islands - Spolszczenie/Res/textslmp.res
- Localization spec:
  - spec/evil-islands-localization.md

Outputs:
- Create or update:
  - resources/universal-mod/res-texts/texts-pol_res
  - resources/universal-mod/res-texts/textslmp-pol_res
- The Polish output directories must have exactly the same filenames as the English source directories.
- Write Polish payload files as Windows-1250 bytes, preserving source line endings where practical.

Required process:
1. Build a translation memory from the Polish vanilla reference .res files by unpacking/parsing them.
2. For each English Universal Mod file:
   - if a matching Polish key exists, compare the English source with the vanilla English/reference meaning before reusing it;
   - if the key exists but the Universal Mod text changed, translate the Universal Mod text freshly and only use the old Polish as terminology guidance;
   - if no Polish key exists, translate from the English Universal Mod source.
3. Preserve filenames and all internal identifiers.
4. Preserve all LMP control/script lines exactly:
   - any line beginning with #;
   - map/resource identifiers;
   - coordinates and numeric blocks.
5. Translate only human-readable text.
6. Keep Polish natural and game-like, not literal.
7. Prefer established Polish vanilla terminology from the reference archive unless it is awkward or conflicts with the new Universal Mod text.
8. Do not modify English/French/Korean sources.
9. Do not pack .res files until the source directories pass validation.

Validation before handoff:
- File set parity:
  - texts-pol_res filenames == texts-eng_res filenames
  - textslmp-pol_res filenames == textslmp-eng_res filenames
- Encoding:
  - every Polish file encodes as Windows-1250;
  - no UTF-8-only characters such as typographic em dash if CP1250 cannot represent them.
- Structural lint:
  - LMP #command lines match English source exactly;
  - map-lmp structural/resource/numeric lines match English source exactly;
  - no internal identifiers are translated.
- Spot-check reused reference entries against Universal Mod English, especially same-key entries whose content may have diverged.
```

## Suggested translation pass order

1. `textslmp-eng_res/UNIT ...` unit names — small, good for glossary.
2. `texts-eng_res/MATSHORT ...` and `MATERIAL ...` — establishes material names.
3. `texts-eng_res/INSTR ...`, `WEAPON ...`, `QITEM ...`, `QUESTITEM ...`.
4. `texts-eng_res/ARMOR ...` — many similar descriptions; use consistent armor-slot vocabulary.
5. `PERK`, `MODIFIER`, `pers`, `string`.
6. LMP briefings/dialogue last, because they need tone and command-line preservation.

## Glossary decisions to lock before full pass

- `Brigand`: prefer `rozbójnik` if following the existing Polish `UNIT lmp_Human_Gipath_Fighter_2`; use `bandyta` only if it sounds better for generic low-tier enemies.
- `Melee`: existing Polish uses `Broń kontaktowa`; for a more modern/natural UI, `Walka wręcz` may be better. Choose once and apply globally.
- `magic wand`: existing Polish likely prefers `różdżka`; avoid overusing `różdżka magiczna` if UI width matters.
- `hide`: `skóra`.
- `Malachite`: `malachit`, adjective `malachitowy`.
- `Mithrill`: keep as `mithrill`, adjective `mithrillowy`.
- Avoid typographic punctuation if writing CP1250 becomes a problem; plain ASCII punctuation is acceptable.
