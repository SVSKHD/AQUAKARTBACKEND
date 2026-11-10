# Storefront AI chat: frontend contract

For the storefront team. This describes what the backend sends for the
customer AI assistant and what the storefront must do with it: product cards,
the one-reply questionnaire, streaming and errors. Source of truth:
`src/routes/ai.js`, `src/controllers/ai.js`, `src/services/aiCatalogue.js`.

## 1. Endpoints

Mounted under `/v1/ai`. Auth is optional: send `Authorization: Bearer <token>`
for a logged-in customer, omit it for guests.

| Method | Path                       | Use                                                       |
| ------ | -------------------------- | --------------------------------------------------------- |
| POST   | `/v1/ai/chat`              | One JSON answer                                           |
| POST   | `/v1/ai/chat/stream`       | Same answer as server-sent events (preferred)             |
| GET    | `/v1/ai/quota`             | Questions left today                                      |
| POST   | `/v1/ai/quota/carry-guest` | After login: count today's guest questions on the account |
| GET    | `/v1/ai/chat/history`      | Logged-in customer's saved chats                          |

Request body (both chat endpoints):

```json
{
  "prompt": "I see a lot of mud in the water",
  "sessionId": "<from the previous answer, logged-in only>",
  "history": [
    { "role": "user", "text": "..." },
    { "role": "model", "text": "..." }
  ],
  "thinking": false
}
```

- Logged in: send `sessionId` from the last answer. The server loads the
  transcript and ignores `history`.
- Guest: send `history` (last 6 turns are used). Nothing is stored.
- Prompt limit: guest 1000 characters, logged in 2000.

JSON answer (`/chat`):

```json
{
  "success": true,
  "data": {
    "reply": "markdown text",
    "sessionId": "...",
    "guest": false,
    "quota": {}
  }
}
```

## 2. Streaming (`/chat/stream`)

Server-sent events over a **POST** response, so use `fetch` and read the body
stream (`EventSource` can't POST). Each event is
`event: <name>\ndata: <json>\n\n`.

| Event     | Data                                           | Frontend                                                                                          |
| --------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `thought` | `{ index, title, text }`                       | Only when `thinking: true`; optional                                                              |
| `delta`   | `{ text }`                                     | Append to the visible answer                                                                      |
| `done`    | `{ reply, thoughts, sessionId, guest, quota }` | Replace the streamed text with `reply`, then build cards and the questionnaire (sections 3 and 4) |
| `error`   | `{ status, message }`                          | Show the message; the question is refunded                                                        |

Errors raised before streaming starts come back as normal JSON with a non-200
status (section 6). If the connection closes without `done`, treat the answer
as failed. The question is refunded.

## 3. Product cards: the bold-name handshake

The reply is markdown. **Every bold span (`**...**`) that matches a catalogue
product is a recommendation and must become a product card under the answer.**
The assistant is told to bold only the products it recommends, never ones it
rules out, so don't add cards for anything that isn't bolded.

1. Load the catalogue once from `GET /v1/all-products?query=ecom` and cache it
   for about 10 minutes (the assistant's catalogue refreshes every 10 minutes).
2. After `done`, collect the bold spans from `reply` in order of appearance.
3. Normalise both the span and each product `title` the same way:
   lowercase, remove a trailing `| Aquakart` (the assistant writes names
   without it), collapse spaces, trim.
4. Exact match on the normalised text. If there is none, accept a match only
   when exactly one product title contains the span (or the span contains the
   title). Otherwise skip the span, since bold text is sometimes not a product.
5. De-duplicate and keep the order of first appearance. Render the cards
   directly under the answer: photo (`photos[0].delivery_url`), title, price,
   offer price, stock and add to cart.
6. Price: show `discountPrice` when `discountPriceStatus` is true and
   `Number(discountPrice) > 0`, else `price`. Some products store
   `discountPrice` as a string, so always convert with `Number()`.

Don't use `GET /v1/product-title/:title` for this. It needs the exact stored
title, including `| Aquakart`.

Items the assistant mentions that are **not** products get no card. Today that
means the non-return valve (NRV) and the customised 0.7–0.9 hp pumps made to
order. A "Get a quote / book a site visit" button for them is optional; it
belongs to the storefront's existing support or lead flow.

Expected cards (live catalogue on 2026-11-09):

| Question                                        | Cards                                                                      |
| ----------------------------------------------- | -------------------------------------------------------------------------- |
| "I stay in a villa, which softener?"            | Kent Automatic Water Softener 25, Kent Automatic Water Softener 40         |
| "Terrace or ground floor?" (automatic softener) | Kent Pressure Bootser, Grundfos 0.7hp Pressure Booster With 24Ltr Air tank |
| "Lot of mud in the water"                       | Kent Sandfilter and/or kent Automatic Sandfilter 100L                      |
| "Orange stains / iron"                          | Kent Iron Filter                                                           |

## 4. The one-reply questionnaire

When the assistant needs details, it ends the answer with one block in this
format:

```text
Quick questions:
1. Water source: borewell / tanker / municipal
2. Home: flat / villa / independent house
3. Bathrooms: 1 / 2 / 3 / 4+
4. What you see: mud or sand / orange or brown stains / white scale / salty taste
5. Install spot: terrace / ground level
Reply in one message, e.g. 1 borewell, 2 villa, 3 4+
```

Questions vary: the assistant asks only what is still unknown. Render the block
as a small form instead of text:

1. Find the line `Quick questions:`. Strip `*`, `#` and spaces first, since the
   model may still format it.
2. Each following line matching `^\s*(\d+)[.)]\s*([^:]+?):\s*(.+)$` is a
   question: number, label, and options from splitting the rest on `/`.
   Lines with fewer than 2 options are free-text questions.
3. The line starting `Reply in one message` ends the block. Don't show it as
   text; it is the hint for the submit button.
4. Show each question as single-select chips, plus one optional "anything
   else" text box.
5. On submit, send **one** chat message built as
   `<number> <option>` joined by `, ` (e.g. `1 borewell, 2 villa, 3 4+, 4 mud or sand`),
   plus the free text if any. Use the same `sessionId`/`history`. Skip
   unanswered questions. Lock the form after sending.
6. If the block doesn't parse (no header, or no valid question line), show the
   reply as plain markdown. The customer can still type the answer.

Everything above the block (problem line, product lines, short bullets) is
normal markdown. Render bold, numbered lists and bullets.

## 5. Answer layout (what to expect)

1. One line naming the likely problem.
2. Recommended products, one line each, name in bold.
3. Up to three short bullets: why, the treatment order (sand filter, then iron
   filter, then softener) and installation.
4. The questionnaire, only when details are missing.

The layout is a prompt rule, not a guaranteed structure. Rendering must not
depend on it except for the bold names and the questionnaire block.

## 6. Errors and quota

| Status      | Body                                                                      | Frontend                                                                            |
| ----------- | ------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| 400         | `{ success: false, message }` (empty or too long prompt, bad `sessionId`) | Show message                                                                        |
| 404         | `Chat session not found`                                                  | Drop the `sessionId` and start a new chat                                           |
| 429         | `{ code: "AI_DAILY_LIMIT", loginRequired, message, quota }`               | Show message; if `loginRequired`, show login. After login call `/quota/carry-guest` |
| 5xx / other | `{ success: false, message }`                                             | Generic retry message                                                               |

Every answer includes `quota`; use it to show questions left.

## 7. Acceptance checklist

- [ ] Villa question shows only the 25 and 40 cards, not 8L, Bathroom 5.5L or
      washing softener cards.
- [ ] Cards appear only for bold names, in reply order, without duplicates.
- [ ] Titles with or without `| Aquakart` match the same product.
- [ ] A string `discountPrice` shows the right offer price.
- [ ] Questionnaire renders as chips, sends one message, and locks.
- [ ] An answer without a questionnaire, or an unparseable one, renders as plain markdown.
- [ ] Stream `error` and a dropped connection show an error, and no cards are built from partial text.
- [ ] 429 for a guest shows the login prompt.
