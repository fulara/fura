# Fura: obrazy inline, generowanie obrazów i kierunek diagramów

## Cel

Doprowadzić Fura do stanu, w którym przeglądarkowy transcript uczciwie pokazuje obrazowe wejścia i wyjścia znane już OMP: wklejone obrazy użytkownika, wyniki narzędzia `generate_image`, screenshoty/preview z tooli oraz przyszłe artefakty wizualne. Nie budować równoległego systemu generowania obrazów w Fura.

## Obserwowany stan

- OMP ma narzędzie `generate_image` w `packages/coding-agent/src/tools/image-gen.ts`.
- Narzędzie zwraca tekstowy opis wyniku oraz obrazy jako `details.images: Array<{ data, mimeType }>`; zapisuje też kopie do tymczasowych plików.
- OMP RPC przyjmuje obrazy w promptach przez `ImageContent { type: "image", data, mimeType }`.
- Fura już umie wysyłać obrazy do OMP:
  - frontend wkleja obrazy do prompta i tworzy `PendingImage`,
  - `src/protocol.rs` przyjmuje `prompt.send.images`,
  - `src/commands.rs` przekazuje obrazy do OMP RPC.
- Fura nie renderuje jeszcze obrazów w transcriptcie:
  - `ContentBlock` ma tylko `text`, `thinking`, `redactedthinking`,
  - `projection.rs::content_to_blocks` ignoruje `type: "image"`,
  - generic tool card renderuje tylko tekst z `result.content`,
  - `generate_image` trzyma obrazy w `result.details.images`, więc UI ich nie pokaże.

## Decyzja architektoniczna

Fura ma być rendererem/projekcją OMP, nie właścicielem semantyki generowania obrazów.

- OMP pozostaje właścicielem:
  - credentials,
  - wyboru providera/modelu,
  - wykonywania `generate_image`,
  - historii wiadomości i tool resultów.
- Fura dodaje:
  - typ projekcji obrazów,
  - bezpieczne renderowanie inline w DOM,
  - UX do podglądu/otwierania obrazów,
  - później wyspecjalizowane renderery dla diagramów i artefaktów wizualnych.

## Czy samo `generate_image` wystarcza?

Nie jako docelowa odpowiedź na „rysowanie” w Fura. Wystarcza jako pierwszy backend do obrazów generatywnych, ale nie pokrywa całej domeny wizualnej.

Potrzebne są co najmniej trzy rozróżnione klasy wizualiów:

1. **Obrazy rastrowe / generatywne**
   - przykłady: ilustracje, mockupy, ikony, stylizowane obrazki,
   - źródło: `generate_image`, screenshoty, upload/wklejenie,
   - reprezentacja: MIME + base64 albo artifact URL.

2. **Diagramy deterministyczne jako kod**
   - przykłady: Mermaid, SVG, PlantUML-like, Graphviz-like,
   - dobre do architektury, sekwencji, zależności, przepływów,
   - reviewowalne, diffowalne, łatwe do poprawiania.

3. **Diagramy edytowalne typu draw.io / diagrams.net**
   - przykłady: diagram systemu, mapa procesów, whiteboard,
   - wymagają zachowania struktury edytowalnej, nie tylko PNG,
   - naturalna reprezentacja: `.drawio` / diagrams.net XML plus preview PNG/SVG.

`generate_image` jest dobre dla klasy 1. Nie powinno zastępować klasy 2 ani 3, bo generatywny obraz nie daje stabilnej, diffowalnej semantyki.

## Rekomendowany kierunek produktu

### MVP: renderowanie tego, co już istnieje

Priorytet: wysoka wartość, niski zakres.

1. Dodać `ContentBlock::Image` w Rust:
   - `data: String`,
   - `mime_type: String`,
   - opcjonalnie `alt: Option<String>`.
2. Dodać odpowiednik `ContentBlock` w `frontend/src/main.ts`:
   - `{ kind: "image"; data: string; mimeType: string; alt?: string }`.
3. Zmapować `content[]` z OMP:
   - `type: "text"` -> text,
   - `type: "image"` -> image,
   - `type: "thinking"` -> thinking,
   - `type: "redactedThinking"` -> redactedthinking.
4. Renderować obrazy w wiadomościach jako thumbnail inline:
   - `img.src = data:${mimeType};base64,${data}`,
   - max-height/max-width CSS,
   - klik otwiera większy podgląd.
5. Renderować obrazy z tool resultów:
   - ogólnie obsłużyć `result.content[]` z `type: "image"`,
   - obsłużyć `result.details.images[]`, bo `generate_image` używa tego miejsca.
6. Dodać specjalny renderer `generate_image`:
   - nagłówek: provider/model/aspect ratio, jeśli dostępne,
   - miniatury wygenerowanych obrazów,
   - tekstowy response summary poniżej albo w details.

### Faza 2: lepszy artifact model zamiast ogromnego base64 w snapshotach

Base64 w WebSocket snapshotach jest prosty, ale kosztowny przy większych obrazach i częstych rerenderach.

Docelowo warto mieć `VisualArtifact`:

```ts
type VisualArtifact =
  | { kind: "inlineImage"; mimeType: string; data: string; alt?: string }
  | { kind: "artifactImage"; mimeType: string; url: string; alt?: string; width?: number; height?: number }
  | { kind: "diagramSource"; format: "mermaid" | "svg" | "drawio"; source: string; previewUrl?: string };
```

Granica spójności:

- MVP może używać inline base64, bo OMP już tak zwraca dane.
- Po MVP większe obrazy powinny przechodzić przez artifact/blob endpoint Fura, żeby transcript nie pompował wielomegabajtowych JSON snapshotów.

### Faza 3: kierunek draw.io / diagrams.net

To nie powinno być „lepszy `generate_image`”, tylko osobny tryb diagramów edytowalnych.

Możliwe kierunki:

1. **Import/render `.drawio` jako artefaktu**
   - Fura rozpoznaje `.drawio` albo diagrams.net XML,
   - pokazuje preview jako SVG/PNG,
   - pozwala pobrać/otworzyć źródło.

2. **„Open in diagrams.net”**
   - Fura trzyma `.drawio` jako artifact,
   - przycisk otwiera diagrams.net z tym plikiem albo importem XML,
   - po edycji użytkownik zapisuje plik z powrotem do repo/artifactu.

3. **Agent generuje źródło diagramu, nie piksele**
   - dla diagramów technicznych agent powinien preferować Mermaid/SVG/drawio XML,
   - obraz rastrowy jest tylko preview,
   - źródło pozostaje reviewowalne w repo.

4. **Późniejszy pełny editor embed**
   - osadzenie diagrams.net w iframe jest możliwe, ale to większy projekt:
     - message protocol iframe <-> Fura,
     - zapis zmian,
     - bezpieczeństwo originów,
     - konflikty edycji,
     - integracja z artifactami/repo.
   - Nie robić tego w MVP.

## UX zasady

- Obraz inline ma być domyślnie miniaturą, nie pełnoekranowym blokiem rozwalającym transcript.
- Klik miniatury otwiera modal/lightbox z pełnym rozmiarem.
- Przy obrazie pokazać MIME i rozmiar, jeśli znany.
- Dla wielu obrazów użyć gridu.
- Dodać akcje:
  - Copy image,
  - Save as,
  - Open full size,
  - Use as input / attach to prompt, później.
- Dla diagramów kodowych pokazać źródło + preview, nie tylko preview.

## Bezpieczeństwo i limity

- Allowlista MIME: `image/png`, `image/jpeg`, `image/webp`, opcjonalnie `image/gif`.
- Nie renderować SVG jako aktywnego DOM bez sanitizacji. SVG traktować ostrożnie:
  - albo jako tekst/źródło,
  - albo jako `img` z blob/data po sanitizacji,
  - nie wstrzykiwać surowego SVG przez `innerHTML`.
- Ustawić limity rozmiaru:
  - maksymalny inline base64 w snapshotcie,
  - większe obrazy jako artifact/blob URL.
- Nie logować raw payloadów obrazów domyślnie.
- Nie wysyłać obrazów do Ask Fura controller dopóki jego kontrakt jawnie ich nie obsługuje.

## Implementacja MVP

### Backend Rust

Pliki:

- `src/session.rs`
- `src/projection.rs`
- ewentualnie testy w istniejących modułach testowych

Zmiany:

1. Rozszerzyć `ContentBlock`:

```rust
#[serde(tag = "kind", rename_all = "lowercase")]
pub(crate) enum ContentBlock {
    Text { text: String },
    Image { data: String, mime_type: String, alt: Option<String> },
    Thinking { thinking: String },
    RedactedThinking,
}
```

Uwaga: serde `rename_all = "camelCase"` dla pól albo jawne `#[serde(rename = "mimeType")]`, żeby frontend dostał `mimeType`, nie `mime_type`.

2. W `content_to_blocks` obsłużyć `Some("image")`:
   - wymaga `data` jako string,
   - wymaga `mimeType` jako string,
   - ignoruje niepełne blocki zamiast pokazywać surowy JSON.

3. `content_to_text` ma pomijać obrazy albo dodawać neutralny marker `[Image: image/png]`; dla copy-message lepszy marker niż milczące zgubienie.

4. Testy:
   - mapuje image content block,
   - ignoruje image block bez `data` albo `mimeType`,
   - tekst + obraz zachowują kolejność,
   - `content_to_text` nie wrzuca base64.

### Frontend TypeScript

Pliki:

- `frontend/src/main.ts`
- `frontend/src/style.css`

Zmiany:

1. Rozszerzyć `ContentBlock` o `image`.
2. Dodać `renderImageBlock` używający `mkEl`, nie `document.createElement`, żeby działało w popoutach.
3. `renderBlock` obsługuje `block.kind === "image"`.
4. `messageText` dla obrazu zwraca marker, np. `[Image: image/png]`, nie base64.
5. Dodać helpery do tool resultów:

```ts
function toolResultImages(value: unknown): Array<{ data: string; mimeType: string; alt?: string }>;
```

Powinien czytać:

- `result.content[]` z `{ type: "image", data, mimeType }`,
- `result.details.images[]` z `{ data, mimeType }`.

6. Dodać renderer dla `generate_image` albo generycznie doklejać image grid w `renderToolCard`.

Rekomendacja MVP: zrobić oba poziomy prosto:

- specjalny nagłówek/summary dla `generate_image`,
- generyczny image grid dla każdego toola, który zwraca obrazy.

### CSS

Dodać klasy:

- `.image-block`
- `.message-image`
- `.tool-image-grid`
- `.tool-image-thumb`
- `.image-lightbox` jeśli modal w MVP

Minimalny CSS:

- thumbnail max-height około 260px,
- object-fit contain,
- border/radius zgodny z istniejącymi tool cardami,
- grid responsive.

## Weryfikacja MVP

1. Rust:
   - `cargo fmt`
   - `cargo test` dla testów projekcji obrazów
   - `cargo check`

2. Frontend:
   - `npm --prefix frontend run build`

3. Manual smoke z mock RPC:
   - dodać/rozszerzyć mock event zawierający message content image,
   - dodać/rozszerzyć mock tool result `generate_image` z `details.images`,
   - uruchomić Fura z mock RPC,
   - sprawdzić w przeglądarce, że obrazy pojawiają się w transcript/tool cardzie.

## Kolejność prac

1. MVP renderowania obrazów z istniejących danych OMP.
2. Lightbox i akcje `open/save/copy`.
3. Artifact/blob endpoint dla większych obrazów.
4. Diagram source renderery: Mermaid/SVG jako kod + preview.
5. `.drawio` jako artifact + preview + open-in-diagrams.net.
6. Dopiero potem rozważyć embed pełnego diagrams.net editora.

## Non-goals MVP

- Nie implementować własnego generatora obrazów w Fura.
- Nie osadzać diagrams.net iframe w pierwszej iteracji.
- Nie zmieniać OMP tool contract, jeśli wystarczy projekcja istniejącego `details.images`.
- Nie renderować surowego SVG przez `innerHTML`.
- Nie wysyłać obrazów do Ask Fura controller bez nowego jawnego kontraktu.
