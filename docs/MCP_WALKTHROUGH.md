<p align="center">
  <img src="https://res.cloudinary.com/aquakartproducts/image/upload/w_1000,c_fill,ar_1:1,g_auto,r_max,bo_5px_solid_red,b_rgb:262c35/v1793926813/logo_nt2v92.png" alt="Aquakart logo (original)" width="120">
  &nbsp;&nbsp;
  <img src="https://res.cloudinary.com/aquakartproducts/image/upload/w_1000,c_fill,ar_1:1,g_auto,r_max,bo_5px_solid_red,b_rgb:262c35/v1793926813/logo-white_rpvptt.png" alt="Aquakart logo (white)" width="120">
</p>

# Aquakart MCP walkthrough

Last reviewed: 2026-11-06 (Asia/Calcutta). This is the step-by-step guide.
The technical reference (every tool, error code, setting and rule) is
[MCP_BLOG_PUBLISHING.md](MCP_BLOG_PUBLISHING.md).

The Aquakart MCP server lets an AI assistant (Claude, ChatGPT or Claude
Code) work on Aquakart for you. It can:

- write and publish blogs
- add products, coupons, categories and subcategories
- fix page SEO
- post to Instagram

The assistant can only do what you allow when you connect it, using your
own CRM account. It never sees customer, order or payment data.

```text
You ──ask──> Claude / ChatGPT ──MCP (signed in as you)──> https://api.aquakart.co.in/v1/mcp
                                                              │
                              blogs · products · coupons · categories · SEO · Instagram
```

---

## 1. Brand logos

The assistant gets these through the `aquakart_get_brand_assets` tool. Use
them as they are: never redraw, recolour, stretch or add effects.

| Logo         | Use on                        | Clean file (use as the reference)                                                                                   | Round badge (display only)                                                                                                                                          |
| ------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Original** | Light or white backgrounds    | [logo_nt2v92.png](https://res.cloudinary.com/aquakartproducts/image/upload/v1793926813/logo_nt2v92.png)             | [badge](https://res.cloudinary.com/aquakartproducts/image/upload/w_1000,c_fill,ar_1:1,g_auto,r_max,bo_5px_solid_red,b_rgb:262c35/v1793926813/logo_nt2v92.png)       |
| **White**    | Dark backgrounds, busy photos | [logo-white_rpvptt.png](https://res.cloudinary.com/aquakartproducts/image/upload/v1793926813/logo-white_rpvptt.png) | [badge](https://res.cloudinary.com/aquakartproducts/image/upload/w_1000,c_fill,ar_1:1,g_auto,r_max,bo_5px_solid_red,b_rgb:262c35/v1793926813/logo-white_rpvptt.png) |

- **Clean file:** the transparent logo. Give this to an image model as the
  reference.
- **Round badge:** the logo in a dark circle with a red border, used on
  the sign-in page. Don't copy the circle or the border into artwork.
- **To get the exact logo on a blog image,** ask for the image _without_ a
  logo. The server then adds the real file bottom-right (step 5.1). An image
  model drawing the logo itself may distort it.

---

## 2. Before you start

You need:

- a CRM staff account with the right permissions (table below)
- Claude (claude.ai, the Desktop app or Claude Code) or ChatGPT with
  connectors/developer mode

| To let the assistant…                           | Your CRM role needs                                           |
| ----------------------------------------------- | ------------------------------------------------------------- |
| Read, draft and publish blogs; upload images    | `blogs.manage`                                                |
| Read or add products; read or change categories | `products.read` / `products.manage` (super-admins have these) |
| Read or create coupons                          | `coupons.read` / `coupons.manage`                             |
| Read or change page SEO                         | `seo.read` / `seo.manage`                                     |
| Post to Instagram                               | `instagram.publish` (and Meta must be set up)                 |

Super-admins have everything. Grant the rest in CRM → Access Control.

---

## 3. Connect

The MCP address for every client is:

```
https://api.aquakart.co.in/v1/mcp
```

Don't open it in a browser. It only answers AI clients and shows an error
otherwise.

### Claude (claude.ai or Desktop)

1. **Settings → Connectors → Add custom connector.**
2. Paste the address above and leave the OAuth Client ID and Secret empty.
3. The **Aquakart sign-in page** opens (step 4).
4. In a chat, open the tools menu and switch the **Aquakart** connector on.

### Claude Code (terminal)

```bash
claude mcp add --transport http aquakart https://api.aquakart.co.in/v1/mcp
```

Then type `/mcp`, choose **aquakart → Authenticate**, and finish on the
sign-in page in your browser.

### ChatGPT

1. Settings → Apps & Connectors → Advanced → turn on **developer mode**.
2. Create a connector with the address above and choose **OAuth**.
3. Finish on the Aquakart sign-in page.

If ChatGPT says _"Couldn't register with Aquakart's sign-in service"_,
see section 7.

---

## 4. The sign-in (consent) page

It shows the Aquakart logo, then asks for:

1. Your **CRM email and password.**
2. **What to allow.** Read access is ticked for you. Anything that changes
   the live website starts **unticked**, so you have to choose it:

   | Box                | Allows                                                | Default                  |
   | ------------------ | ----------------------------------------------------- | ------------------------ |
   | `blogs:read`       | Read blogs, including drafts                          | ticked                   |
   | `blogs:write`      | Create/edit drafts, set title images                  | ticked                   |
   | `media:upload`     | Upload images                                         | ticked                   |
   | `blogs:publish`    | **Publish blogs live**                                | unticked                 |
   | `products:read`    | Read products                                         | ticked                   |
   | `products:write`   | **Add products (live at once)**                       | unticked                 |
   | `coupons:read`     | Read coupons                                          | ticked                   |
   | `coupons:write`    | **Create coupons**                                    | unticked                 |
   | `categories:read`  | Read categories and subcategories                     | ticked                   |
   | `categories:write` | **Create, edit, delete categories and subcategories** | unticked                 |
   | `seo:read`         | Read page SEO and the readiness report                | ticked                   |
   | `seo:write`        | **Create and edit page SEO**                          | unticked                 |
   | `instagram:*`      | Instagram upload, publish, read, cleanup              | publish/cleanup unticked |

3. Click **Allow**. You're connected for up to 30 days, or until someone
   revokes the connection.

**Forgot a box?** You can't add it later from the chat. Disconnect,
reconnect and tick it. If the assistant reports `INSUFFICIENT_SCOPE`, a box
was missing.

---

## 5. What you can ask for

Talk to the assistant in plain language; it picks the tools. Some examples:

### 5.1 Write and publish a blog (with the logo)

> "Write a 900-word blog about choosing a water softener for Hyderabad
> apartments. Make a header image without any logo, attach it with the
> Aquakart logo, show me the draft, then publish it."

What happens:

1. `aquakart_get_brand_assets`: reads the logo rules.
2. `aquakart_create_blog`: saves a **draft**. It's never live at this
   step.
3. `aquakart_upload_image`, then `aquakart_attach_image` with
   `applyBrandLogo: true`: the server puts the real logo bottom-right. For a
   dark image, ask for the **white** logo (`logoVariant: "white"`).
4. You review it. `aquakart_publish_blog` checks the draft and publishes:
   - at least 300 words
   - a meta description
   - a title image
   - a unique slug

   If a check fails, nothing goes live and the assistant says what's
   missing.

### 5.2 Add a product

> "Add a product: Aquakart Auto Softener 25L, ₹24,999, offer ₹19,999, 12 in
> stock, brand Aquakart, in the Softeners category. Use this photo."

- The photo is uploaded first, then the product is created.
- **The product is live on the storefront immediately**; products have no
  draft stage.
- It's kept out of the Google Merchant feed unless you say so.
- Duplicate titles and SKUs are refused.
- Edit or delete products in the CRM.

### 5.3 Create a coupon

> "Create coupon DIWALI10: 10% off, max ₹2,000, minimum order ₹5,000,
> valid till 31 December."

- It's saved as a **draft**, so checkout won't accept it yet. Say "make it
  active" to switch it on, or activate it in the CRM.
- Percentages are capped at 100, and the end date must be in the future.

### 5.4 Categories and subcategories

> "Create a category 'Water Heaters' with this image, then a subcategory
> 'Instant Heaters' under it."

- You can list, view, create, rename and delete them.
- **A delete is refused while anything uses it:** a category with
  subcategories or products, or a subcategory with products.
- Renaming changes the storefront URL, and the assistant warns you.
- Old photos are kept in storage when you replace them.

### 5.5 SEO for every page

> "Which pages need SEO work most? Fix the top five."

1. `aquakart_get_seo_readiness` checks **every** page: home and static
   pages, products, categories, subcategories and blogs. It returns each
   page's status, priority, score and what's missing.
2. The assistant creates or updates each page's SEO record:
   - title
   - description
   - canonical URL
   - Open Graph and Twitter tags
   - JSON-LD
3. To protect a hand-tuned page from the weekly AI SEO job, ask it to set
   **aiLocked**. To switch a page's SEO off, it sets `active: false`; SEO
   pages are never hard-deleted.

### 5.6 Instagram (once Meta is configured)

> "Post this creative to Instagram with this caption."

- The image goes to temporary storage.
- It's posted through Meta's official API and verified. The same image is
  never posted twice.
- The temporary file is deleted automatically about 30 minutes after a
  verified post.

---

## 6. Safety rules

- **Approvals:** every change asks for your approval in Claude or ChatGPT
  before it runs.
- **Drafts first:**
  - blogs are always drafts until you publish
  - coupons are drafts unless you say "active"
  - products and categories are the exception: they're live at once
- **Safe retries:** if a call times out, the assistant retries with the
  same key and nothing is duplicated.
- **Audit log:** every change is recorded with your name, under `mcp.*`
  actions.
- **Removing access:** taking a CRM permission away, or disabling the
  staff account, stops the assistant at once.
- **Nothing else is reachable:** no tool can reach customers, orders,
  invoices or payments.

---

## 7. Troubleshooting

| You see                                                  | Do this                                                                                             |
| -------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| `INSUFFICIENT_SCOPE`                                     | Disconnect, reconnect and tick the missing box (section 4)                                          |
| `PUBLISH_CHECKS_FAILED`                                  | The details list what's missing (words, meta description, title image, slug); fix and publish again |
| `CATEGORY_IN_USE` / `SUBCATEGORY_IN_USE`                 | Move or delete the products or subcategories in the CRM first                                       |
| `DUPLICATE_TITLE`, `COUPON_CODE_TAKEN`, `PAGE_KEY_TAKEN` | Use a different title, code or pageKey, or edit the existing one                                    |
| `REVISION_CONFLICT`                                      | Someone changed it meanwhile; ask the assistant to read it again and retry                          |
| "Couldn't register with Aquakart's sign-in service"      | Ask an admin to check the server log, or use a manual client ID (section 8)                         |
| Still connected with old permissions                     | An admin revokes the connection (section 8), then reconnect                                         |

---

## 8. Admin commands

Run these from the backend folder. They use the database in `.env`, so
point it at production only when you mean to.

```bash
npm run mcp:grants -- list                       # who is connected, with which permissions
npm run mcp:grants -- revoke <grantId>           # end one connection
npm run mcp:grants -- revoke-staff <email>       # end all of one person's connections
npm run mcp:grants -- clients                    # registered AI clients
npm run mcp:grants -- disable-client <clientId>  # block a client and end its connections
npm run mcp:grants -- add-client "ChatGPT" https://chatgpt.com/connector_platform_oauth_redirect
                                                 # manual client ID when auto-registration fails
```

For `add-client`:

- paste the printed client ID into the connector's **OAuth Client ID**
  field and leave the secret empty
- use the exact callback URL the connector page shows

**Server logs** (sign-in problems). No tokens or passwords are ever logged:

```bash
docker logs aquakartbackend_container 2>&1 | grep mcp.oauth | tail -5
```

**Server settings** (Jenkins / container env):

- `MCP_PUBLIC_BASE_URL=https://api.aquakart.co.in` turns MCP on.
- The logo overlay uses `logo_nt2v92` and `logo-white_rpvptt` by default.
  `AQUAKART_LOGO_PUBLIC_ID=none` turns it off.
- Everything else is optional; see `.env.example` and
  [MCP_BLOG_PUBLISHING.md](MCP_BLOG_PUBLISHING.md).

---

## 9. Not verified yet

- **Scheduled runs:** whether a _scheduled or unattended_ Claude/ChatGPT
  task can call these tools (and pass images) hasn't been tested. Run one
  real scheduled test before relying on it.
- **Images from Claude:** Claude sends images as base64, which is fine up
  to 5 MB for blog images.
- **Instagram:** Instagram posting needs the Meta app and token set up
  first, and the token must be renewed about every 60 days.
