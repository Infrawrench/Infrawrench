# The id is in the output of `infrawrench ai-spend sources --json`. An
# imported LiteLLM source has no api_key in state; set it again, or leave it
# unset to keep the stored key.
terraform import infrawrench_ai_request_source.example 3f2e1d0c-9b8a-7f6e-5d4c-3b2a1f0e9d8c
