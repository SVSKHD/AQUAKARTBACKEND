import moment from "moment";

const formattedDeliveryDate = (data) => {
  return moment(data).format("DD-MM-YYYY");
};
export default formattedDeliveryDate;
