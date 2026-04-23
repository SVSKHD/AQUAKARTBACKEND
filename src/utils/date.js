import moment from "moment";

const formattedDeliveryDate = (data) => moment(data).format("DD-MM-YYYY");
export default formattedDeliveryDate;
