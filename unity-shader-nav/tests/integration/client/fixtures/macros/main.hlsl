TEXTURE2D(_MainTex);
SAMPLER(sampler_MainTex);

float4 frag() : SV_Target {
    return SAMPLE_TEXTURE2D(_MainTex, sampler_MainTex, float2(0, 0));
}
