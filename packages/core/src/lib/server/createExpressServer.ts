import { createServer, Server } from 'http';
import cors, { CorsOptions } from 'cors';
import { json } from 'body-parser';
import { expressMiddleware } from '@apollo/server/express4';
import express from 'express';
import type { GraphQLFormattedError, GraphQLSchema } from 'graphql';
import { ApolloServer, ApolloServerOptions } from '@apollo/server';
import { ApolloServerPluginLandingPageDisabled } from '@apollo/server/plugin/disabled';
import { ApolloServerPluginLandingPageLocalDefault } from '@apollo/server/plugin/landingPage/default';
// @ts-expect-error
import graphqlUploadExpress from 'graphql-upload/graphqlUploadExpress.js';
import type { KeystoneConfig, KeystoneContext, GraphQLConfig } from '../../types';

const DEFAULT_MAX_FILE_SIZE = 200 * 1024 * 1024; // 200 MiB

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

export async function createExpressServer (
  config: KeystoneConfig,
  graphQLSchema: GraphQLSchema,
  context: KeystoneContext
): Promise<{
  expressServer: express.Express;
  apolloServer: ApolloServer<KeystoneContext>;
  httpServer: Server;
}> {
  const expressApp = express();
  const httpServer = createServer(expressApp);

  if (config.server?.cors) {
    // Setting config.server.cors = true will provide backwards compatible defaults
    // Otherwise, the user can provide their own config object to use
    const corsConfig: CorsOptions =
      typeof config.server.cors === 'boolean'
        ? { origin: true, credentials: true }
        : config.server.cors;
    expressApp.use(cors(corsConfig));
  }

  expressApp.disable('etag');
  expressApp.disable('x-powered-by');
  expressApp.enable('case sensitive routing');
  expressApp.enable('strict routing');

  if (config.server?.extendExpressApp) {
    await config.server.extendExpressApp(expressApp, context);
  }

  if (config.server?.extendHttpServer) {
    config.server?.extendHttpServer(httpServer, context, graphQLSchema);
  }

  if (config.storage) {
    for (const val of Object.values(config.storage)) {
      if (val.kind !== 'local' || !val.serverRoute) continue;
      expressApp.use(
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
  }

  const apolloConfig = config.graphql?.apolloConfig;
  const playgroundOption = config.graphql?.playground ?? process.env.NODE_ENV !== 'production';
  const apolloServer = new ApolloServer({
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
  } as ApolloServerOptions<KeystoneContext>);

  const maxFileSize = config.server?.maxFileSize || DEFAULT_MAX_FILE_SIZE;
  expressApp.use(graphqlUploadExpress({ maxFileSize }));
  await apolloServer.start();
  expressApp.use(
    config.graphql?.path || '/api/graphql',
    json(config.graphql?.bodyParser),
    expressMiddleware(apolloServer, {
      context: async ({ req, res }) => {
        return await context.withRequest(req, res);
      },
    })
  );

  return { expressServer: expressApp, apolloServer, httpServer };
};
