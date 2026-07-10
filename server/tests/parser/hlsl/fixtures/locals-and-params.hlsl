float4 compute(float4 input, float k)
{
    float scale = k * 2.0;
    float4 result = input * scale;
    return result;
}
