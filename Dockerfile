FROM public.ecr.aws/lambda/nodejs:22

# Install AWS Lambda Web Adapter
COPY --from=public.ecr.aws/awsguru/aws-lambda-web-adapter:0.9.0 /lambda-adapter /opt/extensions/lambda-adapter

# Set port for LWA
ENV PORT=8080
ENV AWS_LWA_INVOKE_MODE=response_stream

# Copy built application
COPY dist/ ${LAMBDA_TASK_ROOT}/dist/
COPY node_modules/ ${LAMBDA_TASK_ROOT}/node_modules/
COPY package.json ${LAMBDA_TASK_ROOT}/

# Start the HTTP transport
CMD ["node", "dist/transports/http.js"]
