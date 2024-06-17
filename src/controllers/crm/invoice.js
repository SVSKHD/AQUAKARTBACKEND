import AquaInvoice from "../../models/crm/invoice.js";

const createInvoice = async (req, res) => {
  try {
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
    res.status(200).json({ message: "Invoice deleted successfully" });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error", error });
  }
};
const getInvoices = async (req, res) => {
  try {
    const invoices = await AquaInvoice.find({});
    return res.status(200).json({ statu: true, data: invoices });
  } catch (error) {
    return res
      .status(400)
      .json({ status: false, message: "Sorry please try again" });
  }
};

const getInvoice = async (req, res) => {
  try {
    const { id, name, phone, invoiceNo } = req.query; // Change from req.params to req.query to get query parameters

    // Construct a dynamic query object
    let query = {};
    if (id) query._id = id;
    if (name) query["customerDetails.name"] = new RegExp(name, "i"); // Case-insensitive regex search
    if (phone) query["customerDetails.phone"] = phone;
    if (invoiceNo) query.invoiceNo = invoiceNo;

    // Find the invoices based on the dynamic query
    const invoices = await AquaInvoice.find(query);

    // Send the found invoices as the response
    res.status(200).json(invoices);
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

const getInvoicesByDate = async (req, res) => {
  try {
    const { month, year, startDate, endDate } = req.query;

    let query = {};

    if (month && year) {
      const { startDate: monthStartDate, endDate: monthEndDate } =
        getMonthDateRange(month, year);
      query.date = {
        $gte: monthStartDate.toISOString(),
        $lte: monthEndDate.toISOString(),
      };
    } else if (startDate && endDate) {
      query.date = {
        $gte: new Date(startDate).toISOString(),
        $lte: new Date(endDate).toISOString(),
      };
    }

    const invoices = await AquaInvoice.find(query);

    res.status(200).json(invoices);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: "Server Error", error });
  }
};

const InvoiceOperations = {
  createInvoice,
  updateInvoice,
  getInvoice,
  getInvoices,
  deleteInvoice,
  getInvoicesByDate,
};

export default InvoiceOperations;
