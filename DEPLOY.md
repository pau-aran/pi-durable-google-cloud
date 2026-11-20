# Deploy to Google Cloud

One GKE Autopilot pod runs the application. Its session files are on a Persistent Disk at `/data`.

## Prerequisites

- A Google Cloud project with billing.
- `gcloud`, signed in (`gcloud auth login`).
- `kubectl`.
- A domain whose DNS records you can change.
- An OpenAI API key in `OPENAI_API_KEY`. To use Gemini on Vertex AI instead, a [Google Cloud API key for Vertex AI](https://cloud.google.com/vertex-ai/generative-ai/docs/start/api-keys) in `GOOGLE_CLOUD_API_KEY`.

## Deploy

1. Select the project and enable the APIs:

   ```sh
   gcloud config set project PROJECT
   gcloud services enable container.googleapis.com artifactregistry.googleapis.com cloudbuild.googleapis.com
   ```

   For Gemini, also enable the Vertex AI API in the project of your API key:

   ```sh
   gcloud services enable aiplatform.googleapis.com
   ```

2. Create the cluster and the image repository, then build the image:

   ```sh
   gcloud container clusters create-auto pi-durable --region us-central1
   gcloud artifacts repositories create pi-durable --repository-format docker --location us-central1
   gcloud builds submit --tag us-central1-docker.pkg.dev/PROJECT/pi-durable/app
   ```

3. In `deploy.yaml`, change the two values marked `# EDIT`: the image and the domain. For Gemini, also change the value of `MODEL_PROVIDER` from `openai` to `google-vertex`.

4. Create the Secret and apply the manifest:

   ```sh
   kubectl create secret generic openai --from-literal=OPENAI_API_KEY="$OPENAI_API_KEY"
   kubectl apply -f deploy.yaml
   ```

   For Gemini, put the Google key in the same Secret instead:

   ```sh
   kubectl create secret generic openai --from-literal=GOOGLE_CLOUD_API_KEY="$GOOGLE_CLOUD_API_KEY"
   ```

   The application uses the default model of the provider, `gpt-6.1-sol` or `gemini-4-argon`. To use a different model, add a `MODEL_ID` entry to `env` in `deploy.yaml`.

   If `MODEL_PROVIDER` is `google-vertex` and the Secret has no `GOOGLE_CLOUD_API_KEY`, the server stops at startup and `kubectl logs pi-durable-0` shows the cause.

## Set DNS

1. Wait until the Ingress has an address. This can take some minutes.

   ```sh
   kubectl get ingress pi-durable
   ```

2. At your DNS provider, set an `A` record from the domain to the value in the `ADDRESS` column.

## Check

- The pod is `Running` and `1/1` ready:

  ```sh
  kubectl get pod pi-durable-0
  kubectl logs pi-durable-0
  ```

- The certificate shows `Certificate Status: Active`. It can take up to 60 minutes after DNS points at the Ingress.

  ```sh
  kubectl describe managedcertificate pi-durable
  ```

- Open `https://` and the domain in a browser. An `http://` address redirects to it.

  ```sh
  curl -sI http://chat.example.com  # 301, Location: https://...
  ```

## Update to a new image

Build again, then restart the pod. The image has no tag, so the new pod pulls the newest build.

```sh
gcloud builds submit --tag us-central1-docker.pkg.dev/PROJECT/pi-durable/app
kubectl rollout restart statefulset pi-durable
kubectl rollout status statefulset pi-durable
```

## Delete everything

The disk is not deleted with the StatefulSet. Delete its claim to delete the session files.

```sh
kubectl delete -f deploy.yaml
kubectl delete pvc data-pi-durable-0
kubectl delete secret openai
gcloud container clusters delete pi-durable --region us-central1
gcloud artifacts repositories delete pi-durable --location us-central1
```

Remove the DNS record.

## Cautions

- Do not force-delete the pod. Kubernetes can then start a second pod with the same name, and two writers can break the session files.
- Do not raise `replicas`. Each pod gets its own disk, and nothing routes a session to its pod.
- SQLite runs with `synchronous = NORMAL`. A commit survives a process crash, but a node failure can lose the newest commits.
- The disk is in one zone. The application is down while that zone is down.
- Add authentication and rate limits before you expose the application. Anyone who can reach it can create sessions that use the model key.
