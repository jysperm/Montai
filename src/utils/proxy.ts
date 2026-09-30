import { EnvHttpProxyAgent, setGlobalDispatcher } from 'undici';

/** Configure Node's fetch after the global env file has been loaded. */
export function configureProxy(): void {
  if (!process.env.HTTP_PROXY && !process.env.http_proxy &&
      !process.env.HTTPS_PROXY && !process.env.https_proxy) return;

  // Keep loopback requests from child Node processes local.
  if (!process.env.NO_PROXY && !process.env.no_proxy) {
    process.env.NO_PROXY = 'localhost,127.0.0.1,::1';
  }

  // update-notifier starts a separate Node process, which reads its inherited
  // proxy settings at startup rather than using our dispatcher.
  process.env.NODE_USE_ENV_PROXY = '1';
  setGlobalDispatcher(new EnvHttpProxyAgent());
}
