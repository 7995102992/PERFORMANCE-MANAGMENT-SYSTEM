package com.sentrifugo.db.mapper;

import com.sentrifugo.db.dto.PmsRatingScaleLevelDTO;
import com.sentrifugo.db.entity.PmsRatingScaleLevelEntity;
import org.mapstruct.Builder;
import org.mapstruct.Mapper;
import org.mapstruct.Mapping;
import org.mapstruct.MappingTarget;
import org.mapstruct.NullValuePropertyMappingStrategy;
import org.mapstruct.ReportingPolicy;

import java.util.List;

@Mapper(
        componentModel = "spring",
        unmappedTargetPolicy = ReportingPolicy.IGNORE,
        nullValuePropertyMappingStrategy = NullValuePropertyMappingStrategy.IGNORE,
        // Lombok @SuperBuilder entities/DTOs: map through constructor + setters (see PmsCycleMapper).
        builder = @Builder(disableBuilder = true)
)
public interface PmsRatingScaleLevelMapper {

    // Parent / referenced entities are resolved and attached by the service, never taken from the DTO.
    @Mapping(target = "ratingScale", ignore = true)
    PmsRatingScaleLevelEntity toEntity(PmsRatingScaleLevelDTO dto);

    @Mapping(source = "ratingScale.id", target = "ratingScaleId")
    PmsRatingScaleLevelDTO toDTO(PmsRatingScaleLevelEntity entity);

    List<PmsRatingScaleLevelEntity> toEntityList(List<PmsRatingScaleLevelDTO> dtoList);

    List<PmsRatingScaleLevelDTO> toDTOList(List<PmsRatingScaleLevelEntity> entityList);

    @Mapping(target = "id", ignore = true)
    @Mapping(target = "ratingScale", ignore = true)
    void updateEntityFromDto(PmsRatingScaleLevelDTO dto, @MappingTarget PmsRatingScaleLevelEntity entity);
}
