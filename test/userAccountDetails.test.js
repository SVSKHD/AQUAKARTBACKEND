import assert from "node:assert/strict";
import test from "node:test";
import { safeUser } from "../src/controllers/googleAuth.js";
import AquaEcomUser from "../src/models/user.js";
import userController, { editableDetails } from "../src/controllers/user.js";

test("the signed-in account carries its address book", () => {
  const home = {
    street: "Plot 12",
    city: "Hyderabad",
    state: "TS",
    postalCode: "500075",
  };
  const user = safeUser({
    _id: "u1",
    email: "a@x.in",
    addresses: [home],
    selectedAddress: home,
  });
  assert.deepEqual(user.addresses, [home]);
  assert.deepEqual(user.selectedAddress, home);
  assert.deepEqual(safeUser({ _id: "u2" }).addresses, []);
  assert.equal(safeUser({ _id: "u2" }).selectedAddress, null);
});

test("a shopper can't change protected account fields", () => {
  assert.deepEqual(
    editableDetails({
      firstName: "Asha",
      addresses: [],
      role: 1,
      password: "x",
      email: "b@x.in",
      $where: "1",
    }),
    { firstName: "Asha", addresses: [] },
  );
  assert.deepEqual(editableDetails(null), {});
  assert.deepEqual(editableDetails([1]), {});
});

test("only profile and address fields are editable; dotted keys are dropped", () => {
  assert.deepEqual(
    editableDetails({
      firstName: "Asha",
      phone: "9876543210",
      selectedAddress: { city: "Hyderabad" },
      resetPasswordOtp: 1234,
      googleData: {},
      loginCount: 0,
      "invoices.0.invoiceId": "x",
      "referral.0.userId": "y",
      alternatePhone: "1",
    }),
    {
      firstName: "Asha",
      phone: "9876543210",
      selectedAddress: { city: "Hyderabad" },
    },
  );
});

// ---------- POST /user/update-details/:id ----------

const makeRes = () => ({
  statusCode: 200,
  body: null,
  status(code) {
    this.statusCode = code;
    return this;
  },
  json(body) {
    this.body = body;
    return this;
  },
});

const stubUpdate = (t, result) => {
  const calls = [];
  t.mock.method(AquaEcomUser, "findByIdAndUpdate", (id, update, options) => {
    calls.push({ id, update, options });
    return {
      select: async () => {
        if (result instanceof Error) throw result;
        return result;
      },
    };
  });
  return calls;
};

const me = { _id: "u1", email: "asha@x.in" };
const update = async (id, newDetails, user = me) => {
  const res = makeRes();
  await userController.updateDetails(
    { params: { id }, body: { newDetails }, user },
    res,
  );
  return res;
};

test("refuses to update someone else's account", async (t) => {
  const calls = stubUpdate(t, { _id: "u2" });
  const res = await update("u2", { firstName: "X" });
  assert.equal(res.statusCode, 403);
  assert.equal(calls.length, 0);
});

test("refuses an email change but accepts the current email resent", async (t) => {
  const calls = stubUpdate(t, { _id: "u1" });
  const changed = await update("u1", { email: "other@x.in", firstName: "A" });
  assert.equal(changed.statusCode, 400);
  assert.match(changed.body.message, /can't be changed/);
  assert.equal(calls.length, 0);

  const same = await update("u1", { email: " Asha@X.in ", firstName: "A" });
  assert.equal(same.statusCode, 200);
  assert.deepEqual(calls[0].update, { $set: { firstName: "A" } });
  assert.equal(calls[0].options.runValidators, true);
});

test("an empty phone clears it instead of storing null", async (t) => {
  const calls = stubUpdate(t, { _id: "u1" });
  const res = await update("u1", { phone: "", lastName: "K" });
  assert.equal(res.statusCode, 200);
  assert.deepEqual(calls[0].update, {
    $set: { lastName: "K" },
    $unset: { phone: 1 },
  });
});

test("a phone already on another account is a 409", async (t) => {
  stubUpdate(t, Object.assign(new Error("dup"), { code: 11000 }));
  const res = await update("u1", { phone: "9876543210" });
  assert.equal(res.statusCode, 409);
});
