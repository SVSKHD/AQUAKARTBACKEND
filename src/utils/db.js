import mongoose from "mongoose"
const mongooseConnect = (url) =>{
mongoose.connect(url).then(()=>{
    console.log("Connected to MongoDB")
}).catch((error)=>{
    console.log(error)
})
}

export default mongooseConnect