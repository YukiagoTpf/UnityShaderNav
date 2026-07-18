float4 UseBuiltinMembers(
  Texture2D<float4> texture,
  SamplerState samplerState,
  float4 color,
  float3x4 transform
) {
  float4 sampled = texture.Sam;
  float2 pair = color.xy;
  float component = transform._m2;
  return texture.Sample(
    samplerState,
    float2(0, 0),
    int2(0, 0)
  ) + sampled + pair.x + component;
}
