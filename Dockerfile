# Use an official Node.js runtime as the base image
FROM node:20

# Set the working directory in the container
WORKDIR /usr/src/app

# Copy package.json and package-lock.json to the working directory
COPY package*.json ./

# Install app dependencies including pm2
RUN npm install pm2 -g
RUN npm install

# Copy the rest of the application code to the working directory
COPY . .

# Expose the port the app runs on
EXPOSE 5300

# Set the command to start the app with pm2
CMD ["pm2-runtime", "prod", "index.js", "--name", "app"]
