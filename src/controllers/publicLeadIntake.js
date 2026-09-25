import {
  buildPlannerQualification,
  calculatePlannerCapacity,
  resolveProductContext,
  upsertLeadFromIntake,
} from "../services/crm/leadIntake.js";

const allowedPlannerValues = {
  residents: new Set(["1-2", "3-4", "5-7", "8+"]),
  coverage: new Set(["bathroom", "multiple", "whole-home"]),
  hardness: new Set(["mild", "hard", "very-hard", "unknown"]),
};

const pickQualification = (input = {}) => {
  const allowed = [
    "locality",
    "pincode",
    "water_source",
    "hardness_ppm",
    "hardness_level",
    "bathrooms",
    "residents",
    "residents_range",
    "coverage",
    "budget_min",
    "budget_max",
    "product_interest",
    "urgency",
    "water_problem",
    "recommended_capacity_liters",
    "recommended_product_id",
    "recommended_product_name",
  ];

  return Object.fromEntries(
    allowed
      .filter((key) => input[key] !== undefined)
      .map((key) => [key, input[key]]),
  );
};

const contactFromBody = (body = {}) => ({
  name: body.name || body.contact_name,
  phone: body.phone,
  email: body.email,
  company_name: body.company_name,
});

const pageFromBody = (body = {}) => ({
  url: body.page_url || body.page?.url,
  path: body.page_path || body.page?.path,
  referrer: body.referrer || body.page?.referrer,
});

const publicLeadResponse = ({ result, extra = {} }) => ({
  success: true,
  data: {
    received: true,
    submission_id: String(result.intakeEvent?._id || ""),
    ...extra,
  },
});

const submitPlannerLead = async (req, res) => {
  try {
    const answers = req.body?.answers || {
      residents: req.body?.residents,
      coverage: req.body?.coverage,
      hardness: req.body?.hardness,
    };

    for (const [key, allowed] of Object.entries(allowedPlannerValues)) {
      if (!allowed.has(String(answers?.[key] || ""))) {
        return res.status(400).json({
          success: false,
          message: `Invalid planner answer: ${key}`,
        });
      }
    }

    const requiredCapacityLiters =
      Number(req.body?.required_capacity_liters) ||
      calculatePlannerCapacity(answers);

    const requestedRecommendations = Array.isArray(req.body?.recommendations)
      ? req.body.recommendations.slice(0, 3)
      : [];

    const recommendations = (
      await Promise.all(
        requestedRecommendations.map((item) =>
          resolveProductContext({
            productId: item?.product_id || item?._id,
            slug: item?.slug,
            url: item?.url,
          }),
        ),
      )
    ).filter(Boolean);

    const primaryRecommendation = recommendations[0] || null;
    const plannerQualification = buildPlannerQualification({
      answers,
      requiredCapacityLiters,
      recommendedProduct: primaryRecommendation,
    });

    const qualification = {
      ...plannerQualification,
      ...pickQualification(req.body?.qualification || {}),
    };

    const result = await upsertLeadFromIntake({
      channel: "planner",
      contact: contactFromBody(req.body),
      source: req.body?.source || "planner",
      page: pageFromBody(req.body),
      message: req.body?.message || "",
      qualification,
      planner: {
        residents: answers.residents,
        coverage: answers.coverage,
        hardness: answers.hardness,
        required_capacity_liters: requiredCapacityLiters,
        recommendation_product_ids: recommendations.map(
          (item) => item.product_id,
        ),
        recommendation_product_names: recommendations.map(
          (item) => item.title,
        ),
      },
      product: primaryRecommendation,
      rawContext: {
        planner_version: String(req.body?.planner_version || "v1"),
      },
    });

    return res.status(result.created ? 201 : 200).json(
      publicLeadResponse({
        result,
        extra: {
          required_capacity_liters: requiredCapacityLiters,
          recommendation_product_ids: recommendations.map(
            (item) => item.product_id,
          ),
        },
      }),
    );
  } catch (error) {
    console.error("submitPlannerLead error:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Unable to submit planner lead",
    });
  }
};

const submitEnquiryLead = async (req, res) => {
  try {
    const qualification = pickQualification({
      ...(req.body?.qualification || {}),
      ...(req.body?.locality !== undefined
        ? { locality: req.body.locality }
        : {}),
      ...(req.body?.pincode !== undefined
        ? { pincode: req.body.pincode }
        : {}),
      ...(req.body?.water_problem !== undefined
        ? { water_problem: req.body.water_problem }
        : {}),
    });

    const result = await upsertLeadFromIntake({
      channel: "website",
      contact: contactFromBody(req.body),
      source: req.body?.source || "website",
      page: pageFromBody(req.body),
      message:
        req.body?.message ||
        req.body?.water_problem ||
        req.body?.notes ||
        "",
      qualification,
      rawContext: {
        form: String(req.body?.form || "enquiry"),
      },
    });

    return res
      .status(result.created ? 201 : 200)
      .json(publicLeadResponse({ result }));
  } catch (error) {
    console.error("submitEnquiryLead error:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Unable to submit enquiry",
    });
  }
};

const submitProductConsultation = async (req, res) => {
  try {
    const product = await resolveProductContext({
      productId: req.body?.product_id,
      slug: req.body?.product_slug || req.body?.slug,
      url: req.body?.product_url || req.body?.page_url,
    });

    if (!product) {
      return res.status(404).json({
        success: false,
        message: "Product not found",
      });
    }

    const qualification = {
      ...pickQualification(req.body?.qualification || {}),
      recommended_product_id: product.product_id,
      recommended_product_name: product.title,
    };

    const result = await upsertLeadFromIntake({
      channel: "product",
      contact: contactFromBody(req.body),
      source: req.body?.source || "product_consultation",
      page: pageFromBody(req.body),
      message:
        req.body?.message ||
        "Customer requested product suitability consultation",
      qualification,
      product,
      rawContext: {
        consultation_type: String(
          req.body?.consultation_type || "product_suitability",
        ),
      },
    });

    return res.status(result.created ? 201 : 200).json(
      publicLeadResponse({
        result,
        extra: {
          product,
        },
      }),
    );
  } catch (error) {
    console.error("submitProductConsultation error:", error);
    return res.status(error.statusCode || 500).json({
      success: false,
      message: error.message || "Unable to submit product consultation",
    });
  }
};

export default {
  submitPlannerLead,
  submitEnquiryLead,
  submitProductConsultation,
};
