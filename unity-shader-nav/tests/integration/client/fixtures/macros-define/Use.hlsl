#include "Macros.hlsl"
float4 frag() {
    return SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, float2(0, 0));
}
