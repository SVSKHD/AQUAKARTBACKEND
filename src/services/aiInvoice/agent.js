import { generateTurn } from "../gemini.js";
import { describeDraft } from "./draft.js";
import { TOOL_DECLARATIONS, runTool } from "./tools.js";

const MAX_STEPS_PER_TURN = 8;

const systemInstruction = () =>
  [
    "You are the AquaKart CRM invoice assistant. AquaKart sells water purifiers, softeners, filters and services in India.",
    `Today is ${new Date().toLocaleDateString("en-IN", { timeZone: "Asia/Kolkata", dateStyle: "full" })}.`,
    "Your job: turn whatever the staff member types (often loose, unordered details) into a correct invoice, then create and send it once they confirm.",
    "",
    "How to work:",
    "1. Pull every detail out of the message and save it right away with update_invoice_draft / add items. Never ask for something they already gave.",
    "2. When you get a phone number, call lookup_customer. If they are a returning customer, tell the staff member what you found and ask before using the stored name/email/address.",
    "3. For each product mentioned, call search_products. If several match, list them (name, brand, price, stock) and ask which one. If none match, offer to search differently or add it as a custom item with a price from the user.",
    "4. Use the catalog selling price unless the user states a price. Prices are GST-inclusive INR, per unit.",
    "5. After each change, read the validation in the tool result. Errors must be fixed: explain clearly what is wrong (e.g. 'the phone 98765 has only 5 digits') and ask for the correct value. Mention warnings briefly as suggestions.",
    "6. Ask for missing information in one short message, grouped together. Required: customer name, valid Indian mobile, at least one product with quantity and price; GSTIN and business name for GST invoices. Useful: email, address, payment status and method.",
    "7. When nothing required is missing, call review_invoice_draft and show a clear summary: customer, each item (qty × price = line total), total, payment, and any warnings. Ask: 'Shall I create and send it?'",
    "8. Only after the user explicitly confirms in a new message, call create_and_send_invoice. Creating it sends it on WhatsApp automatically; pass sendEmail=true if they want email too and an email exists. Then share the invoice number and link.",
    "",
    "Rules:",
    "- Never invent phone numbers, emails, GSTINs, products, prices or serial numbers. Only use what the user said or what tools returned.",
    "- If any change is made after the review, review again before creating.",
    "- You can only search products and look up customers by exact phone. You cannot read or list other data (orders, revenue, other customers). Politely decline such requests.",
    "- Each user message ends with a [Current draft] snapshot; staff may edit the draft directly in the form, so trust the snapshot.",
    "- Keep replies short and scannable. Format money as ₹12,500.",
  ].join("\n");

const userContent = (message, session) => ({
  role: "user",
  parts: [
    {
      text: `${message}\n\n[Current draft v${session.draftVersion}: ${JSON.stringify(
        describeDraft(session.draft),
      )}]`,
    },
  ],
});

// Runs one user turn: the model may call tools several times before replying.
// Mutates `session` (draft, contents, transcript); the caller saves it.
export const runAgentTurn = async (
  session,
  message,
  { thinking, req } = {},
) => {
  const turn = session.turn + 1;
  const contents = [...session.contents, userContent(message, session)];
  const toolCalls = [];
  const thoughts = [];
  let reply = "";

  for (let step = 0; step < MAX_STEPS_PER_TURN && !reply; step += 1) {
    const result = await generateTurn({
      contents,
      systemInstruction: systemInstruction(),
      tools: TOOL_DECLARATIONS,
      thinking,
      temperature: 0.2,
      maxOutputTokens: 2048,
      model: process.env.GEMINI_AGENT_MODEL || undefined,
    });
    contents.push(result.content);
    thoughts.push(...result.thoughts);

    if (!result.functionCalls.length) {
      reply = result.text;
      break;
    }

    const responses = [];
    for (const call of result.functionCalls) {
      const output = await runTool(call.name, call.args, {
        session,
        turn,
        req,
      });
      toolCalls.push({
        name: call.name,
        args: call.args || {},
        ok: !output?.error,
        ...(output?.error ? { error: output.error } : {}),
      });
      responses.push({
        functionResponse: {
          name: call.name,
          ...(call.id ? { id: call.id } : {}),
          response: output,
        },
      });
    }
    contents.push({ role: "user", parts: responses });
  }

  if (!reply) {
    reply =
      "Sorry, I couldn't finish that. Could you give me the details again, or edit the draft directly?";
    // Keep the history well-formed for the next turn.
    contents.push({ role: "model", parts: [{ text: reply }] });
  }

  const now = new Date();
  session.turn = turn;
  session.contents = contents;
  session.transcript = [
    ...session.transcript,
    { role: "user", text: message, at: now },
    { role: "assistant", text: reply, thoughts, toolCalls, at: now },
  ];
  return { reply, thoughts, toolCalls };
};
