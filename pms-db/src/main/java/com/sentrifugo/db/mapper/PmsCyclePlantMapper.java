package com.sentrifugo.db.mapper;

import com.sentrifugo.db.dto.PmsCyclePlantDTO;
import com.sentrifugo.db.entity.PmsCyclePlantEntity;
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
public interface PmsCyclePlantMapper {

    // Parent / referenced entities are resolved and attached by the service, never taken from the DTO.
    @Mapping(target = "cycle", ignore = true)
    PmsCyclePlantEntity toEntity(PmsCyclePlantDTO dto);

    @Mapping(source = "cycle.id", target = "cycleId")
    PmsCyclePlantDTO toDTO(PmsCyclePlantEntity entity);

    List<PmsCyclePlantEntity> toEntityList(List<PmsCyclePlantDTO> dtoList);

    List<PmsCyclePlantDTO> toDTOList(List<PmsCyclePlantEntity> entityList);

    @Mapping(target = "id", ignore = true)
    @Mapping(target = "cycle", ignore = true)
    void updateEntityFromDto(PmsCyclePlantDTO dto, @MappingTarget PmsCyclePlantEntity entity);
}
