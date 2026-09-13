# FORM — AI Workout Generator

FORM is an AI-powered workout plan generator that creates personalized training plans based on a user's fitness goals, experience level, workout frequency, and preferences.

The application uses an AI API through a Node.js/Express backend to generate structured workout plans while keeping the API key secure on the server.

## Features

* Generate personalized workout plans using AI
* Customize workouts based on fitness goals
* Adjust plans based on training experience and workout frequency
* Structured workout days with exercises, sets, reps, and notes
* Nutrition recommendations based on the user's goal
* Responsive and modern user interface
* Secure API key management using environment variables
* Backend API integration using Node.js and Express

## Tech Stack

**Frontend**

* HTML
* CSS
* JavaScript

**Backend**

* Node.js
* Express.js

**API**

* Anthropic Claude API

**Other Tools**

* dotenv
* CORS
* node-fetch
* Git / GitHub
* Render

## How It Works

1. The user enters their fitness information and workout preferences.
2. The frontend creates a prompt based on the user's selections.
3. The application sends the request to the Express backend through the `/generate` endpoint.
4. The backend securely sends the request to the Anthropic API.
5. The AI generates a personalized workout plan.
6. The returned workout data is displayed in an organized workout-plan interface.

## Project Structure

```text
WorkoutGenerator/
├── index.html
├── server.js
├── package.json
├── package-lock.json
├── .gitignore
└── README.md
```

The `.env` file is stored locally and excluded from GitHub to protect the API key.

## Installation

Clone the repository:

```bash
git clone https://github.com/dianaxnguyen/WorkoutGenerator.git
```

Navigate into the project:

```bash
cd WorkoutGenerator
```

Install the required dependencies:

```bash
npm install
```

## Environment Variables

Create a `.env` file in the root of the project:

```text
ANTHROPIC_API_KEY=your_api_key_here
```

Do not commit the `.env` file to GitHub.

Your `.gitignore` should include:

```text
.env
node_modules/
```

## Running the Project Locally

Start the server:

```bash
node server.js
```

Then open:

```text
http://localhost:3000
```

in your browser.

## API Security

The Anthropic API key is never stored in the frontend.

Instead, the browser sends workout-generation requests to the Express backend:

```text
Browser
   ↓
POST /generate
   ↓
Node.js / Express Server
   ↓
Anthropic API
```

The API key is stored as an environment variable and accessed through:

```javascript
process.env.ANTHROPIC_API_KEY
```

This prevents the API key from being exposed in the browser or GitHub repository.

## Deployment

The application can be deployed using Render.

Recommended Render configuration:

```text
Build Command: npm install
Start Command: node server.js
```

The following environment variable must also be added through the Render dashboard:

```text
ANTHROPIC_API_KEY
```

## What I Learned

Through this project, I gained experience with:

* Integrating an AI API into a web application
* Building a backend with Node.js and Express
* Sending and processing asynchronous API requests
* Working with JSON responses
* Managing environment variables and API keys securely
* Debugging HTTP and API authentication errors
* Connecting frontend and backend components
* Deploying a full-stack application

## Future Improvements

Some features I would like to add include:

* User accounts and saved workout plans
* Workout history and progress tracking
* Exercise substitutions
* Estimated workout duration
* Progressive overload recommendations
