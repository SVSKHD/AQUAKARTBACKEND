import AquaCategory from "../models/category";
const getAllCategories = async (req, res) => {
  try {
    const categories = await AquaCategory.find({});
    return res.status(200).json({ success: true, data: categories });
  } catch (error) {
    return res.status(400).json({ success: false, error: error });
  }
};
const getCategory = async (req, res) => {
  const { id } = req.params;
  try {
    const category = await AquaCategory.findById(id);
    return res.status(200).json({ success: true, data: category });
  } catch (error) {
    return res.status(400).json({ success: false, error: error });
  }
};
const updateCategory = async (req, res) => {
  const { id } = req.params;
  const { name, description, image } = req.body;
  try {
    const category = await AquaCategory.findByIdAndUpdate(id, {
      name,
      description,
      image,
    });
    return res.status(200).json({ success: true, data: category });
  } catch (error) {
    return res.status(400).json({ success: false, error: error });
  }
};
const deleteCategory = async (req, res) => {
  const { id } = req.params;
  try {
    const category = await AquaCategory.findByIdAndDelete(id);
    return res.status(200).json({ success: true, data: category });
  } catch (error) {
    return res.status(400).json({ success: false, error: error });
  }
};
const categoryFunctions = () => {
  return {
    getAllCategories,
    getCategory,
    updateCategory,
    deleteCategory,
  };
};

export default categoryFunctions;
