import {
  AquaEnvError,
  RESTART_NOTE,
  aquaEnvStore,
} from "../../services/aquaEnv.js";
import { writeAudit } from "../../services/audit.js";

// CRM management of runtime configuration (collection "aqua-env"). Secret
// values are masked in every response; the audit log records key names and
// flags only, never values.
export const createAquaEnvController = ({
  store = aquaEnvStore,
  audit = writeAudit,
} = {}) => {
  const fail = (res, error) => {
    if (error instanceof AquaEnvError)
      return res.status(error.status).json({
        success: false,
        code: error.code,
        message: error.message,
      });
    if (error?.code === 11000)
      return res.status(409).json({
        success: false,
        code: "CONFLICT",
        message: "The variable was created at the same time; retry.",
      });
    console.error("aqua-env request failed:", error?.message);
    return res.status(500).json({
      success: false,
      code: "SERVER_ERROR",
      message: "Request failed",
    });
  };

  return {
    list: async (_req, res) => {
      try {
        const data = await store.list();
        return res.json({ success: true, data, status: store.status() });
      } catch (error) {
        return fail(res, error);
      }
    },

    get: async (req, res) => {
      try {
        return res.json({
          success: true,
          data: await store.get(req.params.key),
        });
      } catch (error) {
        return fail(res, error);
      }
    },

    set: async (req, res) => {
      try {
        const body = req.body && typeof req.body === "object" ? req.body : {};
        const result = await store.set(
          req.params.key,
          {
            value: body.value,
            secret: body.secret,
            description: body.description,
          },
          req.user?._id ?? null,
        );
        const { variable } = result;
        await audit({
          req,
          action: result.created
            ? "settings.env.create"
            : "settings.env.update",
          resourceType: "aqua-env",
          resourceId: variable.key,
          before: result.previous,
          after: { secret: variable.secret, description: variable.description },
          metadata: { valueChanged: body.value !== undefined },
        });
        return res.status(result.created ? 201 : 200).json({
          success: true,
          data: variable,
          restartNote: RESTART_NOTE,
        });
      } catch (error) {
        return fail(res, error);
      }
    },

    remove: async (req, res) => {
      try {
        const result = await store.remove(req.params.key);
        await audit({
          req,
          action: "settings.env.delete",
          resourceType: "aqua-env",
          resourceId: result.key,
          before: { secret: result.secret },
          metadata: { fallback: result.fallback },
        });
        return res.json({
          success: true,
          data: result,
          restartNote: RESTART_NOTE,
        });
      } catch (error) {
        return fail(res, error);
      }
    },
  };
};

export default createAquaEnvController();
