import { createServer, Server } from 'http';
import cors, { CorsOptions } from 'cors';
import { json } from 'body-parser';
import { expressMiddleware } from '@apollo/server/express4';
import express from 'express';
import type { GraphQLFormattedError, GraphQLSchema } from 'graphql';
import { ApolloServer, ApolloServerOptions } from '@apollo/server';
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
// @ts-ignore
import graphqlUploadExpress from 'graphql-upload/graphqlUploadExpress.js';
import type { __InternalKeystoneConfig, KeystoneContext, GraphQLConfig } from '../../types';
import { addHealthCheck } from './addHealthCheck';

/*
NOTE: This creates the main Keystone express server, including the
GraphQL API, but does NOT add the Admin UI middleware.

The Admin UI takes a while to build for dev, and is created separately
so the CLI can bring up the dev server early to handle GraphQL requests.
*/

function formatError (graphqlConfig: GraphQLConfig | undefined) {
  return (formattedError: GraphQLFormattedError, error: unknown) => {
    let debug = graphqlConfig?.debug;
    if (debug === undefined) {
      debug = process.env.NODE_ENV !== 'production';
    }

    if (!debug && formattedError.extensions) {
      // Strip out any `debug` extensions
      delete formattedError.extensions.debug;
      delete formattedError.extensions.exception;
    }

    if (graphqlConfig?.apolloConfig?.formatError) {
      return graphqlConfig.apolloConfig.formatError(formattedError, error);
    } else {
      return formattedError;
    }
  };
};

export const createExpressServer = async (
  config: __InternalKeystoneConfig,
  graphQLSchema: GraphQLSchema,
  context: KeystoneContext
): Promise<{
  expressServer: express.Express;
  apolloServer: ApolloServer<KeystoneContext>;
  httpServer: Server;
}> => {
  const expressServer = express();
  const httpServer = createServer(expressServer);

  if (config.server.cors !== false) {
    // Setting config.server.cors = true will provide backwards compatible defaults
    // Otherwise, the user can provide their own config object to use
    const corsConfig: CorsOptions =
      typeof config.server.cors === 'boolean'
        ? { origin: true, credentials: true }
        : config.server.cors;
    expressServer.use(cors(corsConfig));
  }

  addHealthCheck({ config, server: expressServer });

  await config.server.extendExpressApp(expressServer, context);
  await config.server.extendHttpServer(httpServer, context, graphQLSchema);

  for (const val of Object.values(config.storage)) {
    if (val.kind !== 'local' || !val.serverRoute) continue;
    expressServer.use(
      val.serverRoute.path,
      express.static(val.storagePath, {
        setHeaders(res) {
          if (val.type === 'file') {
            res.setHeader('Content-Type', 'application/octet-stream');
          }
        },
        index: false,
        redirect: false,
        lastModified: false,
      })
    );
  }

  const apolloConfig = config.graphql.apolloConfig;
  const playgroundOption = config.graphql.playground;
  const serverConfig = {
    formatError: formatError(config.graphql),
    includeStacktraceInErrorResponses: config.graphql?.debug, // If undefined, use Apollo default of NODE_ENV !== 'production'
    ...apolloConfig,
    schema: graphQLSchema,
    plugins:
      playgroundOption === 'apollo'
        ? apolloConfig?.plugins
        : [
            playgroundOption
              ? ApolloServerPluginLandingPageLocalDefault()
              : ApolloServerPluginLandingPageDisabled(),
            ...(apolloConfig?.plugins || []),
          ],
  } as ApolloServerOptions<KeystoneContext>;

  const apolloServer = new ApolloServer({ ...serverConfig });

  expressServer.use(graphqlUploadExpress({ maxFileSize: config.server.maxFileSize }));
  await apolloServer.start();
  expressServer.use(
    config.graphql?.path || '/api/graphql',
    json(config.graphql?.bodyParser),
    expressMiddleware(apolloServer, {
      context: async ({ req, res }) => {
        return await context.withRequest(req, res);
      },
    })
  );

  return { expressServer, apolloServer, httpServer };
};
