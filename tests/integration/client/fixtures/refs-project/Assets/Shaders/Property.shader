Shader "Rename/Property"
{
    Properties
    {
        _Color ("Color", Color) = (1, 1, 1, 1)
    }
    SubShader
    {
        Pass
        {
            HLSLPROGRAM
            float4 _Color;
            float4 frag() : SV_Target { return _Color; }
            ENDHLSL
        }
    }
}
