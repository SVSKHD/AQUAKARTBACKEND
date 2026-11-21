// AQUAKART backend deploy (Docker on the Jenkins host).
// See docs/DEPLOY_JENKINS.md for the one-time Jenkins setup.
//
// Secrets never appear on a command line or in the build log: they come from
// a Jenkins "Secret file" credential (an env file, one NAME=value per line)
// passed with --env-file, and every shell step starts with `set +x`.

pipeline {
  agent any

  options {
    timestamps()
    disableConcurrentBuilds()
  }

  environment {
    IMAGE = 'aquakartbackendapp'
    CONTAINER = 'aquakartbackend_container'
    PORT = '5300'
    // Jenkins credential IDs (Manage Jenkins -> Credentials). Change these if
    // your IDs differ.
    ENV_FILE_CREDENTIAL = 'aquakart-backend-env'
    FIREBASE_CREDENTIAL = 'aquakart-firebase-service-account'
    // Health check: up to HEALTH_TRIES x HEALTH_DELAY seconds for the app to
    // connect to MongoDB, load aqua-env and start listening.
    HEALTH_TRIES = '45'
    HEALTH_DELAY = '2'
  }

  stages {
    stage('Checkout Code') {
      steps {
        checkout scm
      }
    }

    stage('Build Docker Image') {
      steps {
        sh '''
          set +x
          set -e
          docker build -t "$IMAGE:$BUILD_NUMBER" .
          docker tag "$IMAGE:$BUILD_NUMBER" "$IMAGE:latest"
        '''
      }
    }

    stage('Prepare Firebase Secret') {
      steps {
        withCredentials([file(credentialsId: env.FIREBASE_CREDENTIAL, variable: 'FIREBASE_SERVICE_ACCOUNT_FILE')]) {
          sh '''
            set +x
            set -e
            echo "Preparing Firebase Admin credential..."
            docker volume create aquakart_firebase_secrets >/dev/null
            docker run --rm \
              -v aquakart_firebase_secrets:/run/firebase \
              -v "$FIREBASE_SERVICE_ACCOUNT_FILE":/input/firebase.json:ro \
              alpine:3.20 sh -c '
                set -e
                cp /input/firebase.json /run/firebase/service-account.json
                chmod 600 /run/firebase/service-account.json
                test -s /run/firebase/service-account.json
              '
            echo "Firebase Admin credential prepared."
          '''
        }
      }
    }

    stage('Stop Old Container') {
      steps {
        sh '''
          set +x
          docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
        '''
      }
    }

    stage('Run New Container') {
      steps {
        withCredentials([file(credentialsId: env.ENV_FILE_CREDENTIAL, variable: 'APP_ENV_FILE')]) {
          sh '''
            set +x
            set -e
            docker run -d --name "$CONTAINER" --restart unless-stopped \
              -v aquakart_firebase_secrets:/run/secrets/firebase:ro \
              --env-file "$APP_ENV_FILE" \
              -e NODE_ENV=production \
              -e PORT="$PORT" \
              -e GOOGLE_APPLICATION_CREDENTIALS=/run/secrets/firebase/service-account.json \
              -p "$PORT:$PORT" \
              "$IMAGE:$BUILD_NUMBER" >/dev/null
            echo "Started $CONTAINER from $IMAGE:$BUILD_NUMBER"
          '''
        }
      }
    }

    stage('Verify Container') {
      steps {
        sh '''
          set +x
          set -e
          docker exec "$CONTAINER" sh -c '
            test -n "$GOOGLE_APPLICATION_CREDENTIALS" &&
            test -s "$GOOGLE_APPLICATION_CREDENTIALS"
          '
          echo "Firebase credential mounted successfully."

          # The app needs a few seconds (MongoDB, aqua-env) before it listens:
          # retry instead of a single fixed sleep.
          i=1
          while [ "$i" -le "$HEALTH_TRIES" ]; do
            if ! docker ps -q -f "name=^${CONTAINER}$" | grep -q .; then
              echo "Container stopped while starting."
              exit 1
            fi
            if curl -fsS -o /dev/null --max-time 5 "http://localhost:$PORT/v1/status"; then
              echo "Health check passed (attempt $i)."
              exit 0
            fi
            sleep "$HEALTH_DELAY"
            i=$((i + 1))
          done
          echo "Health check failed after $HEALTH_TRIES attempts."
          exit 1
        '''
      }
    }
  }

  post {
    failure {
      sh '''
        set +x
        docker logs --tail 200 "$CONTAINER" 2>&1 || true
      '''
    }
  }
}
