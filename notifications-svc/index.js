import pRetry from "p-retry";
import { ApolloServer, gql } from "apollo-server-express";
import express from "express";
import pg from "pg";
import { PubSub } from "graphql-subscriptions";
import { createServer } from "http";
import { makeExecutableSchema } from "@graphql-tools/schema";
import { WebSocketServer } from "ws";
import { useServer } from "graphql-ws/lib/use/ws";

// Initialize Express
const app = express();

console.log(
  `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] Initializing server components...`
);

const pubSub = new PubSub();
const NOTIFICATION_ADDED = "NOTIFICATION_ADDED";

const typeDefs = gql`
  type Notification {
    id: ID!
    user_id: String!
    message: String!
    created_at: String!
  }

  type Subscription {
    notificationAdded(user_id: String!): Notification
  }

  type Query {
    notifications(user_id: String!): [Notification]
  }
`;

const resolvers = {
  Query: {
    notifications: async (_, { user_id }, { pgClient }) => {
      console.log(
        `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] Fetching notifications for user_id: ${user_id}`
      );
      try {
        const res = await pgClient.query(
          "SELECT * FROM notifications WHERE user_id = $1 ORDER BY created_at DESC",
          [user_id]
        );
        console.log(
          `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] Successfully retrieved ${res.rows.length} notifications for user_id: ${user_id}`
        );
        return res.rows;
      } catch (error) {
        console.error(
          `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] Error fetching notifications for user_id ${user_id}:`,
          error
        );
        throw new Error("Failed to fetch notifications");
      }
    },
  },
  Subscription: {
    notificationAdded: {
      subscribe: (_, { user_id }) => {
        console.log(
          `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] New subscription initiated for user_id: ${user_id}`
        );
        return pubSub.asyncIterator(`${NOTIFICATION_ADDED}_${user_id}`);
      },
    },
  },
};

// Create schema
const schema = makeExecutableSchema({ typeDefs, resolvers });
console.log(
  `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] GraphQL schema created successfully`
);

// Initialize PostgreSQL client
const pgClient = new pg.Client({
  connectionString: process.env.DATABASE_URL,
});

// Connect to PostgreSQL with error handling
async function connectDB() {
  console.log(
    `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] Attempting to connect to PostgreSQL...`
  );
  try {
    await pgClient.connect();
    console.log(
      `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] Successfully connected to PostgreSQL`
    );

    // Set up notification listener after successful connection
    console.log(
      `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] Setting up PostgreSQL notification listener...`
    );
    pgClient.query("LISTEN new_notification");

    pgClient.on("notification", async (notification) => {
      console.log(
        `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] New notification received from PostgreSQL channel:`,
        {
          channel: notification.channel,
          pid: notification.pid,
          payload: notification.payload,
        }
      );

      try {
        if (notification.payload) {
          const payload = JSON.parse(notification.payload);
          console.log(
            `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] Successfully received new-notification payload: '${notification.payload}'`
          );

          if (activeWsConnections.has(payload.user_id)) {
            console.log(
              `[APPLICATION_NAME: ${
                process.env.APPLICATION_NAME
              }] Publishing notification to user_id: '${
                payload.user_id
              }' since it is present in activeWsConnections: '${JSON.stringify([
                ...activeWsConnections.keys(),
              ])}'...`
            );
            await pubSub.publish(`${NOTIFICATION_ADDED}_${payload.user_id}`, {
              notificationAdded: payload,
            });
            console.log(
              `[APPLICATION_NAME: ${
                process.env.APPLICATION_NAME
              }] Successfully published notification to user_id: '${
                payload.user_id
              }' since it is present in activeWsConnections: '${JSON.stringify([
                ...activeWsConnections.keys(),
              ])}'`
            );
          } else {
            console.log(
              `[APPLICATION_NAME: ${
                process.env.APPLICATION_NAME
              }] Cannot publish notification to user_id: '${
                payload.user_id
              }' since it is not present in activeWsConnections: '${JSON.stringify(
                [...activeWsConnections.keys()]
              )}'`
            );
          }
        } else {
          console.warn(
            `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] undefined notification payload received`
          );
        }
      } catch (error) {
        console.error(
          `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] Error processing notification payload:`,
          error
        );
      }
    });
  } catch (error) {
    console.error(
      `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] Failed to connect to PostgreSQL:`,
      error
    );
    throw error;
  }
}

// Initialize Apollo Server
console.log(
  `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] Initializing Apollo Server...`
);
const server = new ApolloServer({
  schema,
  context: async () => ({
    pgClient,
  }),
  plugins: [
    {
      async serverWillStart() {
        console.log(
          `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] Apollo Server starting...`
        );
      },
    },
  ],
});

const activeWsConnections = new Map();

const extractUserIdFromContext = (context) => {
  const headers = context.extra.request.rawHeaders;
  const userIdIndex = headers.indexOf("User-ID");

  if (userIdIndex !== -1) {
    const userId = headers[userIdIndex + 1];
    console.log(
      `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] Extracted User-ID: '${userId}' from context`
    );

    return userId;
  } else {
    console.warn(
      `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] Could not extract User-ID header from context since, User-ID header not found`
    );

    return undefined;
  }
};

// Start the server
async function startServer() {
  try {
    console.log(
      `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] Starting server initialization process...`
    );
    await pRetry(connectDB, {
      onFailedAttempt: (error) => {
        console.log(
          `Attempt ${error.attemptNumber} failed while connecting to DB. There are ${error.retriesLeft} retries left.`
        );
      },
    });
    await server.start();
    console.log(
      `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] Apollo Server started successfully`
    );

    server.applyMiddleware({ app });
    console.log(
      `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] Apollo middleware applied to Express`
    );

    // Create HTTP server
    const httpServer = createServer(app);

    // Set up WebSocket server
    console.log(
      `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] Setting up WebSocket server...`
    );
    const wsServer = new WebSocketServer({
      server: httpServer,
      path: "/graphql",
    });

    // Set up GraphQL over WebSocket protocol
    useServer(
      {
        schema,
        context: async (ctx) => {
          console.log(
            `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] New WebSocket connection established`
          );

          const userId = extractUserIdFromContext(ctx);

          if (userId != undefined && !activeWsConnections.has(userId)) {
            activeWsConnections.set(userId, true);
            console.log(
              `[APPLICATION_NAME: ${
                process.env.APPLICATION_NAME
              }] Context: Successfully added User-ID into activeWsConnections: '${JSON.stringify(
                [...activeWsConnections.keys()]
              )}'`
            );
          } else {
            console.warn(
              `[APPLICATION_NAME: ${
                process.env.APPLICATION_NAME
              }] Context: Cannot set activeWsConnections since userId is undefined or already present in activeWsConnections: '${JSON.stringify(
                [...activeWsConnections.keys()]
              )}'`
            );
          }

          return { pgClient };
        },
        onConnect: (ctx) => {
          console.log(
            `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] Client connected to WebSocket`
          );

          const userId = extractUserIdFromContext(ctx);

          if (userId != undefined) {
            activeWsConnections.set(userId, true);
            console.log(
              `[APPLICATION_NAME: ${
                process.env.APPLICATION_NAME
              }] OnConnect: Successfully added User-ID into activeWsConnections: '${JSON.stringify(
                [...activeWsConnections.keys()]
              )}'`
            );
          } else {
            console.warn(
              `[APPLICATION_NAME: ${
                process.env.APPLICATION_NAME
              }] Context: Cannot set activeWsConnections since userId is undefined or already present in activeWsConnections: '${JSON.stringify(
                [...activeWsConnections.keys()]
              )}'`
            );
          }
        },
        onDisconnect: (ctx) => {
          console.log(
            `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] Client disconnected from WebSocket`
          );

          const userId = extractUserIdFromContext(ctx);

          if (userId != undefined) {
            activeWsConnections.delete(userId);

            console.log(
              `[APPLICATION_NAME: ${
                process.env.APPLICATION_NAME
              }] Context: Successfully removed User-ID: '${userId}' from activeWsConnections: '${JSON.stringify(
                [...activeWsConnections.keys()]
              )}'`
            );
          } else {
            console.warn(
              `[APPLICATION_NAME: ${
                process.env.APPLICATION_NAME
              }] OnDisconnect: Cannot delete User-ID from activeWsConnections: '${JSON.stringify(
                [...activeWsConnections.keys()]
              )}', since User-ID is undefined.`
            );
          }
        },
      },
      wsServer
    );

    const PORT = process.env.PORT || 4000;

    // Start the server
    httpServer.listen(PORT, () => {
      console.log(
        `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] 🚀 Server ready at http://localhost:${PORT}${server.graphqlPath}`
      );
      console.log(
        `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] 🔌 Subscriptions ready at ws://localhost:${PORT}${server.graphqlPath}`
      );
    });
  } catch (error) {
    console.error(
      `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] Fatal error during server startup:`,
      error
    );
    process.exit(1);
  }
}

// Handle process termination
process.on("SIGTERM", () => {
  console.log(
    `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] Received SIGTERM signal. Starting graceful shutdown...`
  );
  pgClient.end();
  process.exit(0);
});

process.on("SIGINT", () => {
  console.log(
    `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] Received SIGINT signal. Starting graceful shutdown...`
  );
  pgClient.end();
  process.exit(0);
});

startServer().catch((error) => {
  console.error(
    `[APPLICATION_NAME: ${process.env.APPLICATION_NAME}] Failed to start server:`,
    error
  );
  process.exit(1);
});
