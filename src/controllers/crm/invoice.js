import AquaInvoice from "../../models/crm/invoice.js";
import { nanoid } from "nanoid";
import sendWhatsAppMessage from "../../notifications/phone/sendWhatsapp.js";

const createInvoice = async (req, res) => {
  try {
    const uniqueId = nanoid(4);
    const date = new Date().getDate();
    const year = new Date().getFullYear();
    const month = new Date().getMonth() + 1;
    const formattedDate = new Date().toISOString().split("T")[0];
    const concateId = `AQB${uniqueId}|${date}${month}${year}`;
    req.body.invoiceNo = concateId;
    req.body.createdAt = formattedDate;
    req.body.updatedAt = formattedDate;
    req.body.date = formattedDate;
    req.body.transport.deliveryDate = formattedDate;
    const newInvoice = new AquaInvoice(req.body);
    const savedInvoice = await newInvoice.save();
    res.status(201).json(savedInvoice);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error", error });
  }
};

const updateInvoice = async (req, res) => {
  try {
    const { id } = req.params;
    console.log("id", id);
    const invoice = await AquaInvoice.findById(id);
    req.body.invoiceNo = invoice.invoiceNo;
    req.body.createdAt = invoice.createdAt;
    req.body.updatedAt = new Date().toISOString().split("T")[0];
    req.body.date = invoice.date;
    req.body.transport.deliveryDate = invoice.transport.deliveryDate;

    const updatedInvoice = await AquaInvoice.findByIdAndUpdate(id, req.body, {
      new: true,
    });

    if (!updatedInvoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    res.status(200).json(updatedInvoice);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error", error });
  }
};
const deleteInvoice = async (req, res) => {
  try {
    const { id } = req.params;
    const deletedInvoice = await AquaInvoice.findByIdAndDelete(id);
    if (!deletedInvoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }
    res
      .status(200)
      .json({ status: true, message: "Invoice deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error", error });
  }
};

const getInvoices = async (req, res) => {
  try {
    // Extract query parameters
    const { gst, po, search, user } = req.query;

    // Build the filter object dynamically
    let filter = {};

    if (gst === "true") {
      filter.gst = true;
    }

    if (po === "true") {
      filter.po = true;
    }

    // ✅ If `user=true`, only return invoices where `gst: false`
    if (user === "true") {
      filter.gst = false;
    }

    // If search is provided, filter by relevant fields (assuming invoiceNumber or clientName)
    if (search) {
      filter.$or = [
        { invoiceNumber: { $regex: search, $options: "i" } }, // Case-insensitive search for invoice number
        { clientName: { $regex: search, $options: "i" } }, // Case-insensitive search for client name
      ];
    }

    // Fetch invoices from the database with filters applied
    const invoices = await AquaInvoice.find(filter)
      .sort({ createdAt: -1 }) // Ensure sorting
      .lean(); // Converts Mongoose documents to plain objects

    return res.status(200).json({
      status: true,
      data: invoices,
      no: invoices.length,
    });
  } catch (error) {
    console.error("Error fetching invoices:", error);
    return res.status(400).json({
      status: false,
      message: "Sorry, please try again",
    });
  }
};

const getInvoice = async (req, res) => {
  try {
    const { id, name, phone, invoiceNo, gstNo, date } = req.query; // Change from req.params to req.query to get query parameters

    // Construct a dynamic query object
    let query = {};
    if (id) query._id = id;
    if (name) query["customerDetails.name"] = new RegExp(name, "i"); // Case-insensitive regex search
    if (phone) query["customerDetails.phone"] = phone;
    if (invoiceNo) query.invoiceNo = invoiceNo;
    if (gstNo) query["gstDetails.gstNo"] = gstNo;
    console.log("invoice", query);
    const invoices = await AquaInvoice.findOne(query);
    res.status(200).json(invoices);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error", error });
  }
};

const getInvoiceById = async (req, res) => {
  try {
    const { id } = req.params; // Extract the id from the request parameters

    const invoice = await AquaInvoice.findById(id);

    if (!invoice) {
      return res.status(404).json({ message: "Invoice not found" });
    }

    // If the invoice is found, return it
    res.status(200).json(invoice);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error", error });
  }
};

const getMonthDateRange = (monthName, year) => {
  const monthIndex = new Date(`${monthName} 1, ${year}`).getMonth();
  const startDate = new Date(year, monthIndex, 1);
  const endDate = new Date(year, monthIndex + 1, 0, 23, 59, 59);
  return { startDate, endDate };
};

const getYearDateRange = (year) => {
  const startDate = new Date(year, 1, 1);
  const endDate = new Date(year, 11, 31, 23, 59, 59);
  console.log(startDate, endDate);
  return { startDate, endDate };
};

const getInvoicesByDate = async (req, res) => {
  try {
    const { month, year, startDate, endDate } = req.query;

    let query = {};

    const parseDate = (dateStr) => {
      if (!dateStr) return null;
      const [day, month, year] = dateStr.split("-").map(Number);
      const fullYear = year < 100 ? 2000 + year : year;
      return new Date(fullYear, month - 1, day);
    };

    const parsedStartDate = parseDate(startDate);
    const parsedEndDate = parseDate(endDate);

    if (month) {
      const resolvedYear = year || new Date().getFullYear();
      const { startDate: monthStartDate, endDate: monthEndDate } =
        getMonthDateRange(month, resolvedYear);
      query.createdAt = {
        $gte: monthStartDate.toISOString(),
        $lte: monthEndDate.toISOString(),
      };
    } else if (year && !month) {
      const { startDate: yearStartDate, endDate: yearEndDate } =
        getYearDateRange(year);
      query.createdAt = {
        $gte: yearStartDate.toISOString(),
        $lte: yearEndDate.toISOString(),
      };
    } else if (parsedStartDate && !parsedEndDate) {
      const start = new Date(
        parsedStartDate.getFullYear(),
        parsedStartDate.getMonth(),
        1,
      );
      const end = new Date(
        parsedStartDate.getFullYear(),
        parsedStartDate.getMonth() + 1,
        0,
        23,
        59,
        59,
      );
      query.createdAt = {
        $gte: start.toISOString(),
        $lte: end.toISOString(),
      };
    } else if (parsedStartDate && parsedEndDate) {
      query.createdAt = {
        $gte: parsedStartDate.toISOString(),
        $lte: new Date(parsedEndDate.setHours(23, 59, 59)).toISOString(),
      };
    } else {
      // If no date is provided, use the current date for both startDate and endDate
      const today = new Date();
      const start = new Date(today.setHours(0, 0, 0, 0)); // Start of the day
      const end = new Date(today.setHours(23, 59, 59)); // End of the day
      query.createdAt = {
        $gte: start.toISOString(),
        $lte: end.toISOString(),
      };
    }
    const invoices = await AquaInvoice.find(query);
    res
      .status(200)
      .json({ success: true, data: invoices, no: invoices.length });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error", error });
  }
};
const NotifyInvoiceMembers = async (req, res) => {
  try {
    const invoices = await AquaInvoice.find({}).lean();
    let success = false;
    const data = req.body;
    const year = new Date().getFullYear();

    if (data.send === "all") {
      if (!data.festival) {
        return res.status(400).json({ error: "Festival name is required." });
      }

      invoices.forEach((invoice) => {
        const { name: customerName, phone } = invoice.customerDetails;
        const { invoiceNo, date, totalAmount: amount, _id: id } = invoice;

        const message = `Dear ${customerName}, we wish you a very happy ${data.festival} ${year}! 🎉 Your invoice ${invoiceNo} dated ${date} for Rs.${amount} is available at https://admin.aquakart.co.in/invoice/${id}.  

✨ **Exclusive Festival Offer:** Get special discounts on your next purchase!  

For more products, browse **_aquakart.co.in_** 🛒`;

        success = true;
      });
      const message = "hello";
      await sendWhatsAppMessage("9553419654", message);

      return res.json({
        success,
        message: "Notifications sent successfully with offers.",
      });
    }

    res.status(400).json({ error: "Invalid request parameters." });
  } catch (error) {
    console.error("Error notifying invoice members:", error);
    res.status(500).json({ error: "Internal server error." });
  }
};

const InvoiceOperations = {
  createInvoice,
  updateInvoice,
  getInvoice,
  getInvoices,
  deleteInvoice,
  getInvoiceById,
  getInvoicesByDate,
  NotifyInvoiceMembers,
};

export default InvoiceOperations;
