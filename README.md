# Coursework Backend (Express + MongoDB)

## Links
- [Vue.js App Repo]: https://github.com/haxsysgit/vue-coursework-frontend
- [Vue.js App GitHub Pages URL]: https://haxsysgit.github.io/vue-coursework-frontend/
- [Express.js App Repo]: https://github.com/haxsysgit/express-coursework-backend
- [Render Base URL]: https://express-coursework-backend.onrender.com

## API Endpoints
- GET / → health check
- GET /lessons → returns all lessons
- GET /search?term=... → search topic, location, price, space (string match, case-insensitive)
- POST /orders → create an order
- PUT /lessons/:id → update lesson fields (e.g., space)

## Postman
- Import: Backend/postman/Backend.postman_collection.json
- Variables:
  - baseUrl = https://express-coursework-backend.onrender.com
  - lessonId1 / lessonId2 → sample ids
  - term → search term (default "a")

## Deployment
- Render Blueprint: render.yaml
- Start command: node server.js
- Environment variables (set in Render):
  - MONGODB_URI (required)
  - DB_NAME (optional, default: coursework-backend)
  - CORS_ORIGINS (comma-separated, include GitHub Pages URL)

## Notes
- Static lesson images are served from /imgs; missing images return JSON error.
- Logger prints method, path, status, and duration for every request.
